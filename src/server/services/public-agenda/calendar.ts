import type { PublicAgendaProjection } from "./types";

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsTimestamp(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.000Z$/, "Z");
}

export function createCalendarExport(
  projection: PublicAgendaProjection,
  sessionSlug: string,
): { calendar: { filename: string; mimeType: "text/calendar"; content: string }; session: PublicAgendaProjection["sessions"][number] } | null {
  const session = projection.sessions.find((candidate) => candidate.slug === sessionSlug);
  if (!session) return null;
  const uid = `${projection.event.slug}-${session.slug}@sympose.local`;
  const publishedAt = "publishedAt" in projection.release ? projection.release.publishedAt : projection.release.sealedAt;
  const description = "abstract" in session && typeof session.abstract === "string"
    ? session.abstract
    : "Session description is not included in this durable release.";
  const roomName = "roomName" in session && typeof session.roomName === "string" ? session.roomName : null;
  const venue = "venue" in session && typeof session.venue === "string" ? session.venue : null;
  const location = roomName !== null && venue !== null
    ? `${roomName}, ${venue}`
    : "Location is not included in this durable release.";
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sympose//Public agenda//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeIcs(uid)}`,
    `DTSTAMP:${icsTimestamp(publishedAt)}`,
    `DTSTART:${icsTimestamp(session.startsAt)}`,
    `DTEND:${icsTimestamp(session.endsAt)}`,
    `SUMMARY:${escapeIcs(session.title)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `LOCATION:${escapeIcs(location)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  return {
    session,
    calendar: {
      filename: `${session.slug}.ics`,
      mimeType: "text/calendar",
      content,
    },
  };
}

export function createItinerary(projection: PublicAgendaProjection, favoriteSessionSlugs: readonly string[]) {
  const favorites = new Set(favoriteSessionSlugs);
  return projection.sessions.filter((session) => favorites.has(session.slug)).sort((first, second) => first.startsAt.localeCompare(second.startsAt));
}
