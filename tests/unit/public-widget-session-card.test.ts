import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionCard } from "@/components/public-widgets/session-surfaces";
import {
  SYNTHETIC_PUBLIC_PROJECTION,
  toPublicWidgetProjection,
} from "@/server/services/public-widgets/contracts";

const widget = toPublicWidgetProjection(SYNTHETIC_PUBLIC_PROJECTION);

function sessionByTitle(title: string) {
  const session = widget.sessions.find((candidate) => candidate.title.startsWith(title));
  if (!session) throw new Error(`Synthetic session ${title} is missing.`);
  return session;
}

describe("public session card anatomy", () => {
  it("renders labeled schedule anatomy and joined speaker metadata", () => {
    const html = renderToStaticMarkup(createElement(SessionCard, {
      widget,
      session: sessionByTitle("Designing trust"),
    }));

    expect(html).toContain("Date:");
    expect(html).toContain("Fri, Sep 18");
    expect(html).toContain("Start time:");
    expect(html).toContain("11:00 AM");
    expect(html).toContain("End time:");
    expect(html).toContain("12:00 PM");
    expect(html).toContain("Room:");
    expect(html).toContain("Studio 1");
    expect(html).toContain("Format:");
    expect(html).toContain("Panel");
    expect(html).toContain("Track:");
    expect(html).toContain("Practice");
    expect(html).toContain("Maya Chen");
    expect(html).toContain("Community systems designer");
    expect(html).toContain("Northstar Collective");
    expect(html).toContain("Jon Bell");
    expect(html).toContain("Researcher and facilitator");
    expect(html).toContain("Common Thread Lab");
    const designingTrust = sessionByTitle("Designing trust");
    const maya = widget.speakers.find((speaker) => speaker.displayName === "Maya Chen");
    if (!maya) throw new Error("Synthetic Maya Chen fixture is missing.");
    expect(html).toContain(`href="/embed/${widget.release.releaseReference}/sessions/${designingTrust.publicReference}"`);
    expect(html).toContain(`href="/embed/${widget.release.releaseReference}/speakers/${maya.publicReference}"`);
    expect(html).toContain(`data-testid="save-session-${designingTrust.publicReference}"`);
  });

  it("truncates long descriptions and keeps the native disclosure closed", () => {
    const longDescription = `${"a".repeat(158)}🧭 after the bounded summary, this remains complete.`;
    const html = renderToStaticMarkup(createElement(SessionCard, {
      widget,
      session: {
        ...sessionByTitle("Opening keynote"),
        description: longDescription,
      },
    }));

    expect(html).toContain("Show more");
    expect(html).toContain(longDescription);
    expect(html).toContain(`${"a".repeat(158)}🧭…`);
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/u);
    expect(html).not.toContain("\uFFFD");
  });

  it("uses truthful room, track, and speaker fallbacks", () => {
    const html = renderToStaticMarkup(createElement(SessionCard, {
      widget,
      session: {
        ...sessionByTitle("Open commons clinic"),
        room: null,
        track: null,
        speakerReferences: [],
        speakers: [],
      },
    }));

    expect(html).toContain("Room:");
    expect(html).toContain("TBA");
    expect(html).toContain("Track:");
    expect(html).toContain("Program");
    expect(html).toContain("No public speakers listed.");
  });
});
