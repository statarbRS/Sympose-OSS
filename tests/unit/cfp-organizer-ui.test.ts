import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  OrganizerCfpFrame,
  OrganizerCfpOverview,
} from "../../src/components/cfp-organizer/organizer-cfp-builder";
import type { OrganizerCfpOverview as OrganizerCfpOverviewModel } from "../../src/server/services/cfp/organizer";

const FORM_FINGERPRINT = "a".repeat(64);
const POLICY_FINGERPRINT = "b".repeat(64);

const overview: OrganizerCfpOverviewModel = {
  event: {
    id: "event-cfp-ui",
    name: "CFP UI event",
    timezone: "UTC",
    lifecycle: "planning",
  },
  calls: [
    {
      callId: "call-cfp-ui",
      eventId: "event-cfp-ui",
      name: "Community call",
      slug: "community-call",
      accessMode: "PUBLIC",
      state: "OPEN",
      timezone: "UTC",
      opensAt: "2026-08-01T00:00:00.000Z",
      closesAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      formVersionId: "form-version-cfp-ui",
      formVersionNumber: 3,
      formFingerprint: FORM_FINGERPRINT,
      ruleVersionId: "rule-version-cfp-ui",
      ruleFingerprint: "c".repeat(64),
      policyFingerprint: POLICY_FINGERPRINT,
      submissionCounts: {
        draft: 2,
        submitted: 4,
        withdrawn: 1,
        invalidated: 0,
      },
    },
  ],
};

describe("organizer CFP presentation", () => {
  it("keeps the frame header to two children and marks the active organizer tab", () => {
    const html = renderToStaticMarkup(
      createElement(OrganizerCfpFrame, {
        workspace: "northstar",
        event: overview.event,
        children: createElement("p", null, "Overview content"),
      }),
    );
    const header = html.match(/<header[^>]*>([\s\S]*?)<\/header>/u)?.[1] ?? "";

    expect(header).toContain("<div>");
    expect(header).toContain("</div><p>");
    expect(header).toContain("Call for proposals");
    expect(header).not.toMatch(/^<p/iu);
    expect(html).toContain('aria-current="page"');
  });

  it("renders version evidence, lineage, next steps, and a full fingerprint title from the call query", () => {
    const html = renderToStaticMarkup(
      createElement(OrganizerCfpOverview, {
        workspace: "northstar",
        event: overview.event,
        calls: overview.calls,
      }),
    );

    expect(html).toContain("Form v3");
    expect(html).toContain("Immutable form version");
    expect(html).toContain(`title="Form version fingerprint: ${FORM_FINGERPRINT}"`);
    expect(html).toContain("Version lineage");
    expect(html).toContain("form-version-cfp-ui");
    expect(html).toContain("rule-version-cfp-ui");
    expect(html).toContain("Next steps");
    expect(html).toContain("Publish when ready");
    expect(html).toContain(`title="Policy fingerprint: ${POLICY_FINGERPRINT}"`);
  });
});
