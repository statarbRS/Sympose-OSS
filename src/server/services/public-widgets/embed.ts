import type { PublicWidgetProjection } from "./contracts";

export const EMBED_MODES = ["sessions", "speakers", "gallery", "agenda", "itinerary"] as const;
export type EmbedMode = (typeof EMBED_MODES)[number];
export const EMBED_THEMES = ["light", "dark", "auto"] as const;
export type EmbedTheme = (typeof EMBED_THEMES)[number];

const CHANNEL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONFIGURATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const EMBED_CONFIGURATION_STORAGE_PREFIX = "sympose:public-embed-config:";
export const MAX_SAVED_EMBED_CONFIGURATIONS = 12;
const EMBED_ACCENTS = ["teal", "violet", "coral"] as const;
export type EmbedAccent = (typeof EMBED_ACCENTS)[number];

export interface EmbedConfiguration {
  readonly mode: EmbedMode;
  readonly theme: EmbedTheme;
  readonly accent: EmbedAccent;
  readonly search: boolean;
}

export interface SavedEmbedConfiguration {
  readonly id: string;
  readonly label: string;
  readonly configuration: EmbedConfiguration;
  readonly savedAt: string;
}

const DEFAULT_EMBED_CONFIGURATION: EmbedConfiguration = {
  mode: "sessions",
  theme: "light",
  accent: "teal",
  search: true,
};

function first(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function bool(value: string): boolean {
  return value !== "0" && value !== "false";
}

function normalizeEmbedBaseOrigin(baseOrigin: string): string {
  if (typeof baseOrigin !== "string" || baseOrigin.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(baseOrigin)) {
    throw new Error("EMBED_BASE_ORIGIN_INVALID");
  }

  let parsed: URL;
  try {
    parsed = new URL(baseOrigin);
  } catch {
    throw new Error("EMBED_BASE_ORIGIN_INVALID");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.href !== `${parsed.origin}/`
  ) {
    throw new Error("EMBED_BASE_ORIGIN_INVALID");
  }

  return parsed.origin;
}

export function parseEmbedConfiguration(
  input: URLSearchParams | Record<string, string | string[] | undefined>,
): EmbedConfiguration {
  const read = (key: string): string =>
    input instanceof URLSearchParams ? input.get(key) ?? "" : first(input[key]);
  const mode = read("mode");
  const theme = read("theme");
  const accent = read("accent");
  return {
    mode: (EMBED_MODES.includes(mode as EmbedMode) ? mode : DEFAULT_EMBED_CONFIGURATION.mode) as EmbedMode,
    theme: (EMBED_THEMES.includes(theme as EmbedTheme) ? theme : DEFAULT_EMBED_CONFIGURATION.theme) as EmbedTheme,
    accent: EMBED_ACCENTS.includes(accent as EmbedAccent)
      ? (accent as EmbedConfiguration["accent"])
      : DEFAULT_EMBED_CONFIGURATION.accent,
    search: read("search") === "" ? DEFAULT_EMBED_CONFIGURATION.search : bool(read("search")),
  };
}

export function embedQuery(configuration: EmbedConfiguration, configurationId?: string): string {
  const query = new URLSearchParams({
    mode: configuration.mode,
    theme: configuration.theme,
    accent: configuration.accent,
    search: configuration.search ? "1" : "0",
  });
  if (configurationId !== undefined) {
    if (!isEmbedConfigurationId(configurationId)) {
      throw new Error("EMBED_CONFIGURATION_ID_INVALID");
    }
    query.set("configId", configurationId);
  }
  return query.toString();
}

export function embedConfigurationStorageKey(channelReference: string): string {
  if (!CHANNEL_REFERENCE_PATTERN.test(channelReference)) {
    throw new Error("EMBED_CHANNEL_REFERENCE_INVALID");
  }
  return `${EMBED_CONFIGURATION_STORAGE_PREFIX}${encodeURIComponent(channelReference)}`;
}

export function embedActiveConfigurationStorageKey(channelReference: string): string {
  return `${embedConfigurationStorageKey(channelReference)}:active`;
}

function parseStoredConfiguration(value: unknown): EmbedConfiguration | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!EMBED_MODES.includes(record.mode as EmbedMode) || !EMBED_THEMES.includes(record.theme as EmbedTheme)) return null;
  if (!EMBED_ACCENTS.includes(record.accent as EmbedAccent) || typeof record.search !== "boolean") return null;
  return {
    mode: record.mode as EmbedMode,
    theme: record.theme as EmbedTheme,
    accent: record.accent as EmbedConfiguration["accent"],
    search: record.search,
  };
}

/**
 * Parse a persisted configuration value without applying query-string defaults. Server-side
 * commands use this strict form so malformed client input cannot silently become a valid save.
 */
export function parseEmbedConfigurationValue(value: unknown): EmbedConfiguration | null {
  return parseStoredConfiguration(value);
}

export function isEmbedConfiguration(value: unknown): value is EmbedConfiguration {
  return parseStoredConfiguration(value) !== null;
}

export function isEmbedConfigurationId(value: unknown): value is string {
  return typeof value === "string" && CONFIGURATION_ID_PATTERN.test(value);
}

export function parseStoredEmbedConfiguration(raw: string | null): EmbedConfiguration | null {
  if (!raw) return null;
  try {
    return parseStoredConfiguration(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseSavedEmbedConfigurations(raw: string | null): readonly SavedEmbedConfiguration[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_SAVED_EMBED_CONFIGURATIONS) return [];
    const seen = new Set<string>();
    const saved: SavedEmbedConfiguration[] = [];
    for (const value of parsed) {
      if (value === null || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      if (typeof record.id !== "string" || !isEmbedConfigurationId(record.id) || seen.has(record.id)) return [];
      if (
        typeof record.label !== "string" ||
        record.label.trim().length === 0 ||
        record.label.trim() !== record.label ||
        record.label.length > 240 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(record.label)
      ) return [];
      if (typeof record.savedAt !== "string" || Number.isNaN(Date.parse(record.savedAt))) return [];
      const configuration = parseStoredConfiguration(record.configuration);
      if (!configuration) return [];
      seen.add(record.id);
      saved.push({ id: record.id, label: record.label, configuration, savedAt: record.savedAt });
    }
    return saved;
  } catch {
    return [];
  }
}

export function serializeSavedEmbedConfigurations(configurations: readonly SavedEmbedConfiguration[]): string {
  return JSON.stringify(configurations.slice(0, MAX_SAVED_EMBED_CONFIGURATIONS));
}

export function savedEmbedConfigurationLabel(configuration: EmbedConfiguration): string {
  return `${configuration.mode} · ${configuration.theme} · ${configuration.accent} · ${configuration.search ? "search on" : "compact"}`;
}

export function buildEmbedSnippet(
  channelReference: string,
  configuration: EmbedConfiguration,
  baseOrigin?: string,
  configurationId?: string,
): string {
  if (!CHANNEL_REFERENCE_PATTERN.test(channelReference)) {
    throw new Error("EMBED_CHANNEL_REFERENCE_INVALID");
  }
  const query = embedQuery(configuration, configurationId);
  const gallerySuffix = configuration.mode === "gallery" ? "/gallery" : "";
  const srcPath = `/embed/${encodeURIComponent(channelReference)}${gallerySuffix}?${query}`;
  const src = baseOrigin === undefined
    ? srcPath
    : new URL(srcPath, normalizeEmbedBaseOrigin(baseOrigin)).toString();
  return `<iframe title="${configuration.mode} · ${channelReference}" src="${src}" loading="lazy" referrerpolicy="no-referrer" style="width:100%;min-height:520px;border:0" allow="fullscreen"></iframe>`;
}

export interface PublicWidgetFeed {
  readonly schema: "public-widget-feed/v1";
  readonly channelReference: string;
  readonly releaseNumber: number;
  readonly sealedAt: string;
  readonly releaseReference: string;
  readonly event: PublicWidgetProjection["event"];
  readonly sessions: PublicWidgetProjection["sessions"];
  readonly speakers: PublicWidgetProjection["speakers"];
}

export function buildPublicWidgetFeed(widget: PublicWidgetProjection): PublicWidgetFeed {
  return Object.freeze({
    schema: "public-widget-feed/v1",
    channelReference: widget.release.channelReference,
    releaseNumber: widget.release.releaseNumber,
    sealedAt: widget.release.sealedAt,
    releaseReference: widget.release.releaseReference,
    event: widget.event,
    sessions: widget.sessions,
    speakers: widget.speakers,
  });
}
