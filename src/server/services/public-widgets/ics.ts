import type { PublicSession, PublicWidgetProjection } from "./contracts";

const MAX_ICS_SELECTION = 500;

export class IcsExportInputError extends Error {
  readonly code = "ICS_EXPORT_INPUT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "IcsExportInputError";
  }
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/;/gu, "\\;")
    .replace(/,/gu, "\\,")
    .replace(/\r\n|\r|\n/gu, "\\n");
}

function icsUtc(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new IcsExportInputError("Session time is invalid.");
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function foldIcsLine(line: string): string {
  const pieces: string[] = [];
  let remaining = line;
  let first = true;
  while (remaining.length > 75) {
    const width = first ? 75 : 74;
    pieces.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
    first = false;
  }
  pieces.push(remaining);
  return pieces.join("\r\n ");
}

function sessionEvent(widget: PublicWidgetProjection, session: PublicSession): string[] {
  const uid = `${session.publicReference}@${widget.release.channelReference}.sympose`;
  const location = session.room ?? "";
  const categories = [session.track, session.format].filter(Boolean).join(",");
  return [
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${icsUtc(widget.release.sealedAt)}`,
    `DTSTART:${icsUtc(session.startsAt)}`,
    `DTEND:${icsUtc(session.endsAt)}`,
    `SUMMARY:${escapeIcsText(session.title)}`,
    `DESCRIPTION:${escapeIcsText(session.description)}`,
    `LOCATION:${escapeIcsText(location)}`,
    `CATEGORIES:${escapeIcsText(categories)}`,
    `X-SYMPOSE-SESSION-REFERENCE:${escapeIcsText(session.publicReference)}`,
    "END:VEVENT",
  ];
}

export function buildIcsCalendar(
  widget: PublicWidgetProjection,
  requestedSessionReferences?: readonly string[],
): string {
  const requested = requestedSessionReferences ?? widget.sessions.map((session) => session.publicReference);
  if (requested.length > MAX_ICS_SELECTION) {
    throw new IcsExportInputError("Calendar selection is too large.");
  }
  const sessionsByReference = new Map(widget.sessions.map((session) => [session.publicReference, session]));
  const seen = new Set<string>();
  const sessions: PublicSession[] = [];
  for (const reference of requested) {
    if (seen.has(reference)) continue;
    seen.add(reference);
    const session = sessionsByReference.get(reference);
    if (!session) throw new IcsExportInputError("The requested session is not in this public release.");
    sessions.push(session);
  }
  sessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.publicReference.localeCompare(b.publicReference));

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sympose//Public Widget//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(widget.event.title)}`,
    ...sessions.flatMap((session) => sessionEvent(widget, session)),
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}
