"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import type { EmbedConfiguration, SavedEmbedConfiguration } from "@/server/services/public-widgets/embed";
import {
  buildEmbedSnippet,
  EMBED_MODES,
  EMBED_THEMES,
  embedQuery,
  savedEmbedConfigurationLabel,
} from "@/server/services/public-widgets/embed";
import type { PublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import { embedPath as widgetPath } from "@/app/embed/_paths";
import type { PublicEmbedManagerViewModel } from "./public-widget-client-view";

import styles from "./styles.module.css";

type SaveActionResult =
  | {
      readonly ok: true;
      readonly created: boolean;
      readonly configuration: SavedEmbedConfiguration;
    }
  | { readonly ok: false; readonly message: string };

type SaveAction = (formData: FormData) => Promise<SaveActionResult>;

function configurationHref(
  channel: string,
  suffix: string,
  configuration: EmbedConfiguration,
  configurationId: string | null,
  surfaceMode?: EmbedConfiguration["mode"],
): string {
  const nextConfiguration = surfaceMode ? { ...configuration, mode: surfaceMode } : configuration;
  const resolvedSuffix = suffix || (nextConfiguration.mode === "gallery" ? "/gallery" : "");
  return `${widgetPath(channel, resolvedSuffix)}?${embedQuery(nextConfiguration, configurationId ?? undefined)}`;
}

function newIdempotencyKey(): string {
  if (typeof window !== "undefined" && typeof window.crypto?.randomUUID === "function") {
    return `embed-config:${window.crypto.randomUUID()}`;
  }
  return `embed-config:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 12)}`;
}

export function EmbedManager({
  widget,
  configuration,
  configurationId = null,
  initialSavedConfigurations = [],
  eventId,
  saveAction,
  baseOrigin,
  publicPreview = true,
}: {
  readonly widget: PublicWidgetProjection | PublicEmbedManagerViewModel;
  readonly configuration: EmbedConfiguration;
  readonly configurationId?: string | null;
  readonly initialSavedConfigurations?: readonly SavedEmbedConfiguration[];
  readonly eventId?: string;
  readonly saveAction?: SaveAction;
  readonly baseOrigin?: string;
  /** Public preview retains query navigation; organizer mode keeps the user on publication. */
  readonly publicPreview?: boolean;
}) {
  const channel = widget.release.channelReference;
  const [current, setCurrent] = useState<EmbedConfiguration>(configuration);
  const [currentId, setCurrentId] = useState<string | null>(configurationId);
  const [saved, setSaved] = useState<readonly SavedEmbedConfiguration[]>(initialSavedConfigurations);
  const [label, setLabel] = useState(savedEmbedConfigurationLabel(configuration));
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const [browserOrigin, setBrowserOrigin] = useState(baseOrigin ?? "");

  useEffect(() => {
    if (!baseOrigin) setBrowserOrigin(window.location.origin);
  }, [baseOrigin]);

  const snippet = useMemo(
    () => buildEmbedSnippet(channel, current, browserOrigin || undefined, currentId ?? undefined),
    [browserOrigin, channel, current, currentId],
  );
  const preview = configurationHref(channel, "", current, currentId);
  const feedHref = `${widgetPath(channel, "/feed")}?${embedQuery(current, currentId ?? undefined)}`;

  function updateCurrent(next: EmbedConfiguration): void {
    setCurrent(next);
    setCurrentId(null);
    setLabel(savedEmbedConfigurationLabel(next));
    idempotencyKey.current = null;
  }

  function updateQuery(message: string): void {
    if (publicPreview) {
      window.history.replaceState(null, "", configurationHref(channel, "/configure", current, currentId));
    }
    setNotice(message);
  }

  async function saveConfiguration(): Promise<void> {
    if (!saveAction || !eventId) {
      setNotice("Only an authenticated organizer can persist an embed configuration.");
      return;
    }
    if (!idempotencyKey.current) idempotencyKey.current = newIdempotencyKey();
    setSaving(true);
    try {
      const formData = new FormData();
      formData.set("eventId", eventId);
      formData.set("label", label.trim() || savedEmbedConfigurationLabel(current));
      formData.set("mode", current.mode);
      formData.set("theme", current.theme);
      formData.set("accent", current.accent);
      formData.set("search", current.search ? "1" : "0");
      formData.set("idempotencyKey", idempotencyKey.current);
      const result = await saveAction(formData);
      if (!result.ok) {
        setNotice(result.message);
        return;
      }
      const next = [result.configuration, ...saved.filter((entry) => entry.id !== result.configuration.id)].slice(0, 12);
      setSaved(next);
      setCurrentId(result.configuration.id);
      setLabel(result.configuration.label);
      if (publicPreview) {
        window.history.replaceState(null, "", configurationHref(channel, "/configure", current, result.configuration.id));
      }
      setNotice(result.created ? "Embed configuration saved." : "The idempotent embed save returned the existing configuration.");
    } catch {
      setNotice("The embed configuration could not be saved. Reload and try again.");
    } finally {
      setSaving(false);
    }
  }

  function loadConfiguration(entry: SavedEmbedConfiguration): void {
    setCurrent(entry.configuration);
    setCurrentId(entry.id);
    setLabel(entry.label);
    idempotencyKey.current = null;
    if (publicPreview) {
      window.history.replaceState(null, "", configurationHref(channel, "/configure", entry.configuration, entry.id));
    }
    setNotice(`Loaded ${entry.label}.`);
  }

  async function copySnippet(): Promise<void> {
    try {
      await navigator.clipboard.writeText(snippet);
      setNotice("Embed snippet copied to the clipboard.");
    } catch {
      setNotice("Clipboard access is unavailable; select the snippet below to copy it.");
    }
  }

  return (
    <div data-testid="embed-manager">
      <section className={styles.hero}>
        <p className={styles.eyebrow}>Public embed channel · organizer configuration</p>
        <h1 className={styles.title}>Share the published program</h1>
        <p className={styles.lede}>Configure a small, read-only projection of public release {widget.release.releaseNumber}. The snippet remains bound to a sealed public projection and never reaches organizer fields.</p>
        {publicPreview ? <p className={styles.meta}>Public preview of the sealed audience projection.</p> : <p className={styles.meta}>Public release reference: <code>{"releaseReference" in widget.release ? widget.release.releaseReference : "unavailable"}</code></p>}
        {publicPreview ? <p className={styles.browserNotice}>This is a public preview. Sign in through the event publication surface to save a durable configuration.</p> : <p className={styles.browserNotice}>Saved configurations are event-scoped and reload from the server. They are immutable publication configuration events.</p>}
      </section>

      {notice ? <p className={styles.status} role="status" data-testid="embed-save-state">{notice}</p> : null}

      <form className={styles.configForm} onSubmit={(event) => { event.preventDefault(); updateQuery("Preview updated from the selected configuration."); }}>
        <div className={styles.field}>
          <label htmlFor="embed-mode">Surface</label>
          <select className={styles.select} id="embed-mode" value={current.mode} onChange={(event) => updateCurrent({ ...current, mode: event.target.value as EmbedConfiguration["mode"] })}>
            {EMBED_MODES.map((mode) => <option key={mode} value={mode}>{mode[0].toUpperCase() + mode.slice(1)}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="embed-theme">Theme</label>
          <select className={styles.select} id="embed-theme" value={current.theme} onChange={(event) => updateCurrent({ ...current, theme: event.target.value as EmbedConfiguration["theme"] })}>
            {EMBED_THEMES.map((theme) => <option key={theme} value={theme}>{theme[0].toUpperCase() + theme.slice(1)}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="embed-accent">Accent</label>
          <select className={styles.select} id="embed-accent" value={current.accent} onChange={(event) => updateCurrent({ ...current, accent: event.target.value as EmbedConfiguration["accent"] })}>
            <option value="teal">Teal</option><option value="violet">Violet</option><option value="coral">Coral</option>
          </select>
        </div>
        {!publicPreview ? <div className={styles.field}><label htmlFor="embed-label">Configuration label</label><input className={styles.input} id="embed-label" value={label} maxLength={240} onChange={(event) => setLabel(event.target.value)} /></div> : null}
        <label className={styles.checkboxField} htmlFor="embed-search"><input id="embed-search" type="checkbox" checked={current.search} onChange={(event) => updateCurrent({ ...current, search: event.target.checked })} /> Enable search controls</label>
        <div className={styles.formActions}>
          <button className={styles.buttonSecondary} type="submit">Update preview</button>
          {!publicPreview ? <button className={styles.button} type="button" onClick={() => { void saveConfiguration(); }} disabled={saving}>{saving ? "Saving…" : "Save configuration"}</button> : null}
        </div>
      </form>

      {!publicPreview ? <section className={styles.savedConfigurations} aria-labelledby="saved-embed-configurations-title">
        <div className={styles.sectionHeading}><h2 id="saved-embed-configurations-title">Saved embed configurations</h2><span>{saved.length} event-scoped</span></div>
        {saved.length === 0 ? <p className={styles.empty}>No saved configuration yet. Choose a surface, theme, accent, and search setting, then save it here.</p> : <ul className={styles.savedList}>{saved.map((entry) => <li className={styles.savedItem} key={entry.id}><div><strong>{entry.label}</strong><span className={styles.meta}>ID <code>{entry.id}</code> · saved {entry.savedAt}</span></div><div className={styles.savedActions}><button className={styles.buttonSecondary} type="button" onClick={() => loadConfiguration(entry)}>Load</button></div></li>)}</ul>}
      </section> : null}

      <div className={styles.managerGrid}>
        <article className={styles.managerCard}><h2>Sessions</h2><p>Searchable program cards with time, room, track, format, approved speaker links, and save-to-itinerary controls.</p><Link className={styles.speakerLink} href={configurationHref(channel, "/sessions", current, currentId)}>Open sessions →</Link></article>
        <article className={styles.managerCard}><h2>Speakers</h2><p>A compact directory for browsing approved speaker profiles and their published sessions.</p><Link className={styles.speakerLink} href={configurationHref(channel, "/speakers", current, currentId, "speakers")}>Open speakers →</Link></article>
        <article className={styles.managerCard}><h2>Gallery</h2><p>Photo-forward speaker cards with surname ordering, search, fallback initials, and gallery-specific profile links.</p><Link className={styles.speakerLink} href={configurationHref(channel, "/gallery", current, currentId, "gallery")}>Open gallery →</Link></article>
        <article className={styles.managerCard}><h2>Agenda</h2><p>Day navigation groups the same sealed session objects used by the directory and public agenda.</p><Link className={styles.speakerLink} href={configurationHref(channel, "/agenda", current, currentId)}>Open agenda →</Link></article>
        <article className={styles.managerCard}><h2>Personal itinerary</h2><p>Favorites-only schedule with complete metadata and a browser-local calendar export.</p><Link className={styles.speakerLink} href={configurationHref(channel, "/itinerary", current, currentId)}>Open itinerary →</Link></article>
        <article className={styles.managerCard}><h2>Public feed</h2><p>Stable JSON feed for a first-party integration. It contains the same public release fields as this projection.</p><Link className={styles.speakerLink} href={feedHref}>Open feed →</Link></article>
      </div>

      <label className={styles.codeLabel} htmlFor="embed-snippet">Embed snippet</label>
      <textarea className={`${styles.textarea} ${styles.snippet}`} id="embed-snippet" readOnly value={snippet} />
      <div className={styles.codeActions}><button className={styles.button} type="button" onClick={() => { void copySnippet(); }}>Copy embed snippet</button><Link className={styles.buttonSecondary} href={`/embed/${encodeURIComponent(channel)}/snippet?${embedQuery(current, currentId ?? undefined)}`}>Open snippet response</Link></div>
      <p className={styles.meta}>Preview: <Link className={styles.speakerLink} href={preview}>{preview}</Link></p>
    </div>
  );
}
