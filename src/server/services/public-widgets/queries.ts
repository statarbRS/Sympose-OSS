import type {
  PublicSession,
  PublicSpeaker,
  PublicWidgetProjection,
} from "./contracts";

export interface PublicSessionFilters {
  readonly query?: string;
  readonly track?: string;
  readonly format?: string;
  readonly day?: string;
  readonly speakerReference?: string;
}

export interface PublicSessionFacet {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export interface PublicAgendaDay {
  readonly date: string;
  readonly label: string;
  readonly sessions: readonly PublicSession[];
}

export interface PublicSpeakerFilters {
  readonly query?: string;
  readonly sessionReference?: string;
}

export function firstQueryValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

const COMMON_SURNAME_PARTICLES: ReadonlySet<string> = new Set([
  "af",
  "al",
  "ap",
  "ben",
  "bin",
  "da",
  "de",
  "del",
  "della",
  "den",
  "der",
  "di",
  "do",
  "dos",
  "du",
  "ibn",
  "la",
  "le",
  "st",
  "st.",
  "ten",
  "ter",
  "van",
  "von",
  "zu",
  "zur",
]);

interface PublicSpeakerNameSortKey {
  readonly surname: string;
  readonly givenName: string;
  readonly displayName: string;
}

/**
 * This is intentionally a bounded directory sort, not locale-aware name parsing:
 * normalize and collapse whitespace, treat a one-token name as a mononym/surname,
 * keep hyphenated tokens intact, and attach only contiguous allowlisted particles
 * immediately before the final token to the surname.
 */
function publicSpeakerNameSortKey(displayName: string): PublicSpeakerNameSortKey {
  const tokens = displayName.normalize("NFKC").trim().split(/\s+/u).filter(Boolean);
  const foldedTokens = tokens.map((token) => token.toLocaleLowerCase("en-US"));
  if (foldedTokens.length === 0) {
    return { surname: "", givenName: "", displayName: "" };
  }

  let surnameStart = foldedTokens.length - 1;
  while (surnameStart > 0) {
    const precedingToken = foldedTokens[surnameStart - 1];
    if (precedingToken === undefined || !COMMON_SURNAME_PARTICLES.has(precedingToken)) break;
    surnameStart -= 1;
  }

  return {
    surname: foldedTokens.slice(surnameStart).join(" "),
    givenName: foldedTokens.slice(0, surnameStart).join(" "),
    displayName: foldedTokens.join(" "),
  };
}

function comparePublicSpeakers(a: PublicSpeaker, b: PublicSpeaker): number {
  const left = publicSpeakerNameSortKey(a.displayName);
  const right = publicSpeakerNameSortKey(b.displayName);
  return (
    left.surname.localeCompare(right.surname, "en-US") ||
    left.givenName.localeCompare(right.givenName, "en-US") ||
    left.displayName.localeCompare(right.displayName, "en-US") ||
    a.publicReference.localeCompare(b.publicReference, "en-US")
  );
}

function localDateForInstant(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function labelForDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(instant);
}

function sessionSearchText(session: PublicSession): string {
  return normalized([
    session.title,
    session.description,
    session.room ?? "",
    session.track ?? "",
    session.format,
    ...session.speakers.map((speaker) => speaker.displayName),
  ].join(" "));
}

function matchesSession(
  widget: PublicWidgetProjection,
  session: PublicSession,
  filters: PublicSessionFilters,
): boolean {
  const query = normalized(filters.query ?? "");
  if (query && !sessionSearchText(session).includes(query)) return false;
  if (filters.track && normalized(session.track ?? "") !== normalized(filters.track)) return false;
  if (filters.format && normalized(session.format) !== normalized(filters.format)) return false;
  if (filters.day && localDateForInstant(session.startsAt, widget.event.timezone) !== filters.day) return false;
  if (
    filters.speakerReference &&
    !session.speakerReferences.includes(filters.speakerReference)
  ) {
    return false;
  }
  return true;
}

export function compareSessions(a: PublicSession, b: PublicSession): number {
  return a.startsAt.localeCompare(b.startsAt) || a.publicReference.localeCompare(b.publicReference);
}

export function listPublicSessions(
  widget: PublicWidgetProjection,
  filters: PublicSessionFilters = {},
): readonly PublicSession[] {
  return [...widget.sessions].filter((session) => matchesSession(widget, session, filters)).sort(compareSessions);
}

function facetValues(values: readonly (string | null)[]): readonly PublicSessionFacet[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === null || value.trim().length === 0) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

export function publicSessionFacets(
  widget: PublicWidgetProjection,
): { readonly tracks: readonly PublicSessionFacet[]; readonly formats: readonly PublicSessionFacet[] } {
  return {
    tracks: facetValues(widget.sessions.map((session) => session.track)),
    formats: facetValues(widget.sessions.map((session) => session.format)),
  };
}

export function listPublicSpeakers(
  widget: PublicWidgetProjection,
  filters: PublicSpeakerFilters = {},
): readonly PublicSpeaker[] {
  const query = normalized(filters.query ?? "");
  return [...widget.speakers]
    .filter((speaker) => {
      if (filters.sessionReference && !speaker.sessionReferences.includes(filters.sessionReference)) {
        return false;
      }
      if (!query) return true;
      return normalized([
        speaker.displayName,
        speaker.headline,
        speaker.organization ?? "",
        speaker.bio,
      ].join(" ")).includes(query);
    })
    .sort(comparePublicSpeakers);
}

export function getPublicSession(
  widget: PublicWidgetProjection,
  sessionReference: string,
): PublicSession | null {
  return widget.sessions.find((session) => session.publicReference === sessionReference) ?? null;
}

export function getPublicSpeaker(
  widget: PublicWidgetProjection,
  speakerReference: string,
): PublicSpeaker | null {
  return widget.speakers.find((speaker) => speaker.publicReference === speakerReference) ?? null;
}

export function listPublicAgendaDays(widget: PublicWidgetProjection): readonly PublicAgendaDay[] {
  const byDate = new Map<string, PublicSession[]>();
  for (const session of listPublicSessions(widget)) {
    const date = localDateForInstant(session.startsAt, widget.event.timezone);
    const sessions = byDate.get(date) ?? [];
    sessions.push(session);
    byDate.set(date, sessions);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sessions]) => ({
      date,
      label: labelForDate(date),
      sessions: sessions.sort(compareSessions),
    }));
}

export function getPublicAgendaDay(
  widget: PublicWidgetProjection,
  date: string,
): PublicAgendaDay | null {
  return listPublicAgendaDays(widget).find((day) => day.date === date) ?? null;
}

export function getSessionDay(widget: PublicWidgetProjection, session: PublicSession): string {
  return localDateForInstant(session.startsAt, widget.event.timezone);
}
