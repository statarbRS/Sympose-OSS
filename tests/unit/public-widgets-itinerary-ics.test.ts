import { describe, expect, it } from "vitest";
import { SYNTHETIC_PUBLIC_PROJECTION, toPublicWidgetProjection, type PublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import { buildIcsCalendar, escapeIcsText, IcsExportInputError } from "@/server/services/public-widgets/ics";
import { InMemoryItineraryPersistence, itineraryStorageKey, LocalStorageItineraryPersistence, toggleItineraryReference } from "@/server/services/public-widgets/itinerary";
import { publicReleaseReference } from "@/server/services/public-reference";

const widget = toPublicWidgetProjection(SYNTHETIC_PUBLIC_PROJECTION);
const key = { releaseReference: widget.release.releaseReference } as const;
const sessionReference = (title: string): string => {
  const session = widget.sessions.find((candidate) => candidate.title.startsWith(title));
  if (!session) throw new Error(`Synthetic session ${title} is missing.`);
  return session.publicReference;
};

describe("public widget itinerary and calendar export", () => {
  it("keeps the in-memory itinerary deterministic and sealed-release scoped", () => {
    const persistence = new InMemoryItineraryPersistence();
    expect(persistence.read(key)).toEqual([]);
    const designingTrust = sessionReference("Designing trust");
    const openingKeynote = sessionReference("Opening keynote");
    expect(toggleItineraryReference(persistence, key, designingTrust)).toEqual([designingTrust]);
    expect(toggleItineraryReference(persistence, key, openingKeynote)).toEqual([designingTrust, openingKeynote].sort());
    expect(toggleItineraryReference(persistence, key, designingTrust)).toEqual([openingKeynote]);
    const supersedingKey = {
      releaseReference: publicReleaseReference({
        workspaceId: "workspace-synthetic-public",
        eventId: "event-synthetic-sympose",
        releaseId: "release-synthetic-public-v2",
      }),
    } as const;
    expect(persistence.read(supersedingKey)).toEqual([]);
    expect(itineraryStorageKey(key)).toContain(widget.release.releaseReference);
    expect(itineraryStorageKey(key)).not.toContain("demo-public");
    expect(itineraryStorageKey(key)).not.toContain("workspace-synthetic-public");
  });

  it("reloads the same browser-local itinerary through a fresh persistence instance", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (storageKey: string) => values.get(storageKey) ?? null,
      setItem: (storageKey: string, value: string) => { values.set(storageKey, value); },
      removeItem: (storageKey: string) => { values.delete(storageKey); },
    };
    const firstVisit = new LocalStorageItineraryPersistence(storage);
    const openingKeynote = sessionReference("Opening keynote");
    expect(toggleItineraryReference(firstVisit, key, openingKeynote)).toEqual([openingKeynote]);

    const reloadedVisit = new LocalStorageItineraryPersistence(storage);
    expect(reloadedVisit.read(key)).toEqual([openingKeynote]);
  });

  it("escapes RFC 5545 text and emits a stable selected-session calendar", () => {
    expect(escapeIcsText("A\\B,C;D\nE")).toBe("A\\\\B\\,C\\;D\\nE");
    const designingTrust = sessionReference("Designing trust");
    const openingKeynote = sessionReference("Opening keynote");
    const ics = buildIcsCalendar(widget, [designingTrust, openingKeynote]);
    const unfoldedIcs = ics.replaceAll("\r\n ", "");
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(unfoldedIcs).toContain(`UID:${openingKeynote}@${widget.release.channelReference}.sympose`);
    expect(ics.indexOf("DTSTART:20260918T073000Z")).toBeLessThan(ics.indexOf("DTSTART:20260918T090000Z"));
    expect(ics).not.toContain(`${designingTrust},${openingKeynote}`);
  });

  it("does not allow an unknown or oversized selection to escape the release", () => {
    expect(() => buildIcsCalendar(widget, ["not-in-release"])).toThrow(IcsExportInputError);
    expect(() => buildIcsCalendar(widget, Array.from({ length: 501 }, () => sessionReference("Opening keynote")))).toThrow(IcsExportInputError);
  });

  it("escapes hostile session text before it reaches the calendar payload", () => {
    const hostile = structuredClone(widget) as unknown as PublicWidgetProjection;
    const openingKeynote = sessionReference("Opening keynote");
    const session = hostile.sessions.find((candidate) => candidate.publicReference === openingKeynote);
    if (!session) throw new Error("fixture session missing");
    (session as { title: string; description: string }).title = "Title, with; separators\nsecond line";
    (session as { title: string; description: string }).description = "Description\r\nEND:VEVENT\nBEGIN:VEVENT";
    const ics = buildIcsCalendar(hostile, [openingKeynote]);
    expect(ics).toContain("SUMMARY:Title\\, with\\; separators\\nsecond line");
    expect(ics).toContain("DESCRIPTION:Description\\nEND:VEVENT\\nBEGIN:VEVENT");
    expect(ics.split("\r\n").filter((line) => line === "END:VEVENT")).toHaveLength(1);
  });
});
