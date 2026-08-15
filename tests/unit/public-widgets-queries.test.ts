import { describe, expect, it } from "vitest";
import { SYNTHETIC_PUBLIC_PROJECTION, toPublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import {
  getPublicAgendaDay,
  listPublicAgendaDays,
  listPublicSessions,
  listPublicSpeakers,
  publicSessionFacets,
} from "@/server/services/public-widgets/queries";

const widget = toPublicWidgetProjection(SYNTHETIC_PUBLIC_PROJECTION);

function sessionReference(title: string): string {
  const session = widget.sessions.find((candidate) => candidate.title.startsWith(title));
  if (!session) throw new Error(`Synthetic session ${title} is missing.`);
  return session.publicReference;
}

function speakerReference(displayName: string): string {
  const speaker = widget.speakers.find((candidate) => candidate.displayName === displayName);
  if (!speaker) throw new Error(`Synthetic speaker ${displayName} is missing.`);
  return speaker.publicReference;
}

describe("public widget filters and cross-surface consistency", () => {
  it("searches session title, description, and approved speaker display names", () => {
    expect(listPublicSessions(widget, { query: "maya" }).map((session) => session.publicReference)).toEqual([
      sessionReference("Opening keynote"),
      sessionReference("Designing trust"),
    ]);
    expect(listPublicSessions(widget, { query: "next step" }).map((session) => session.publicReference)).toEqual([
      sessionReference("Open commons clinic"),
    ]);
    expect(listPublicSpeakers(widget, { query: "common thread" }).map((speaker) => speaker.publicReference)).toEqual([
      speakerReference("Jon Bell"),
    ]);
  });

  it("orders speakers by surname without changing the projection order", () => {
    const projectionOrder = widget.speakers.map((speaker) => speaker.publicReference);

    expect(listPublicSpeakers(widget).map((speaker) => speaker.displayName)).toEqual([
      "Jon Bell",
      "Maya Chen",
      "Lara Owens",
    ]);
    expect(widget.speakers.map((speaker) => speaker.publicReference)).toEqual(projectionOrder);
  });

  it("handles bounded name shapes and uses public references for ties", () => {
    const template = widget.speakers[0]!;
    const namedWidget = {
      ...widget,
      speakers: [
        { ...template, publicReference: "smith-jones", displayName: " Ada Smith-Jones " },
        { ...template, publicReference: "mononym", displayName: "  Plato  " },
        { ...template, publicReference: "de-la-cruz-z", displayName: " Aisha   de la Cruz " },
        { ...template, publicReference: "de-la-cruz-b", displayName: "Aisha de la Cruz" },
        { ...template, publicReference: "de-la-cruz-a", displayName: "Aisha de la Cruz" },
      ],
    };

    expect(listPublicSpeakers(namedWidget).map((speaker) => speaker.publicReference)).toEqual([
      "de-la-cruz-a",
      "de-la-cruz-b",
      "de-la-cruz-z",
      "mononym",
      "smith-jones",
    ]);
  });

  it("keeps surname ordering after speaker filters are applied", () => {
    expect(
      listPublicSpeakers(widget, { sessionReference: sessionReference("Designing trust") }).map(
        (speaker) => speaker.publicReference,
      ),
    ).toEqual([speakerReference("Jon Bell"), speakerReference("Maya Chen")]);
  });

  it("provides deterministic track/format facets and exact filters", () => {
    const facets = publicSessionFacets(widget);
    expect(facets.tracks).toEqual([
      { value: "Ideas", label: "Ideas", count: 1 },
      { value: "Main stage", label: "Main stage", count: 1 },
      { value: "Practice", label: "Practice", count: 2 },
    ]);
    expect(listPublicSessions(widget, { track: "practice", format: "Panel" }).map((session) => session.publicReference)).toEqual([
      sessionReference("Designing trust"),
    ]);
  });

  it("groups the same public session records into local agenda days", () => {
    const days = listPublicAgendaDays(widget);
    expect(days.map((day) => day.date)).toEqual(["2026-09-18", "2026-09-19"]);
    expect(days.map((day) => day.sessions.map((session) => session.publicReference))).toEqual([
      [sessionReference("Opening keynote"), sessionReference("Designing trust")],
      [sessionReference("The future of commons"), sessionReference("Open commons clinic")],
    ]);
    expect(getPublicAgendaDay(widget, "2026-09-19")?.sessions[1]?.title).toBe("Open commons clinic");
  });

  it("keeps speaker links reciprocal across session cards, directory, and detail projections", () => {
    const sessionReferences = new Set(widget.sessions.map((session) => session.publicReference));
    const speakerReferences = new Set(widget.speakers.map((speaker) => speaker.publicReference));
    for (const session of widget.sessions) {
      expect(session.speakerReferences.every((reference) => speakerReferences.has(reference))).toBe(true);
      for (const reference of session.speakerReferences) {
        expect(widget.speakers.find((speaker) => speaker.publicReference === reference)?.sessionReferences).toContain(session.publicReference);
      }
    }
    for (const speaker of widget.speakers) {
      expect(speaker.sessionReferences.every((reference) => sessionReferences.has(reference))).toBe(true);
      for (const reference of speaker.sessionReferences) {
        expect(widget.sessions.find((session) => session.publicReference === reference)?.speakerReferences).toContain(speaker.publicReference);
      }
    }
  });
});
