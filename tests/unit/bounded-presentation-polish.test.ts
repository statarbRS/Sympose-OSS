import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

describe("bounded presentation polish contracts", () => {
  it("formats the landing release from its sealed projection while retaining the machine value", () => {
    const landing = source("src/app/page.tsx");

    expect(landing).toContain('data-testid="landing-sealed-at"');
    expect(landing).toContain("dateTime={attendeeRelease.projection.release.sealedAt}");
    expect(landing).toContain("attendeeRelease.projection.event.timezone");
    expect(landing).toContain("UTC fallback; requested timezone ${timezone} unavailable");
    expect(landing).toContain("Unformatted timestamp · ${value}");
  });

  it("visually abbreviates the organizer proposal reference without changing its full DOM authority", () => {
    const route = source("src/app/w/[workspace]/events/[eventId]/review/page.tsx");
    const routeCss = source("src/app/w/[workspace]/events/[eventId]/review/review-page.module.css");
    const consoleSource = source("src/components/cfp-review/organizer-review-console.tsx");

    expect(route).toContain("Proposal references are abbreviated for scanning");
    expect(route).toContain("<OrganizerReviewConsole workspace={workspace} surface={surface} />");
    expect(consoleSource).toContain("data-selected-submission-id={selectedRanking.submissionId}");
    expect(consoleSource).toContain("<code>{selectedRanking.submissionId}</code>");
    expect(routeCss).toContain('[data-testid="selected-proposal-detail"] > header p code');
    expect(routeCss).toContain('content: "Proposal ref ";');
    expect(routeCss).toContain("text-overflow: ellipsis;");
    expect(routeCss).toContain("user-select: all;");
  });
});
