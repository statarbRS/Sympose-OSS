import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/cfp/actions", () => ({
  saveApplicantDraftAction: vi.fn(),
  submitApplicantDraftAction: vi.fn(),
}));

import {
  CO_PRESENTERS_FIELD_CONFIG_SCHEMA,
  CO_PRESENTERS_VALUE_SCHEMA,
} from "../../src/cfp/co-presenters";
import type { ApplicantDraftView } from "../../src/components/cfp/contracts";
import { ApplicantDraftForm } from "../../src/components/cfp/draft-form";

describe("CFP co-presenter applicant projection", () => {
  it("renders a resumed bounded value with full name, email, and role labels", () => {
    const field = {
      id: "coPresenters",
      type: "longText" as const,
      label: "Co-presenters / coauthors",
      required: false,
      defaultVisibility: "visible" as const,
      config: {
        schema: CO_PRESENTERS_FIELD_CONFIG_SCHEMA,
        maxEntries: 2,
        roles: ["co-speaker", "moderator"],
      },
    };
    const value = {
      schema: CO_PRESENTERS_VALUE_SCHEMA,
      entries: [
        { fullName: "Ada Lovelace", email: "ada@example.test", role: "co-speaker" },
        { fullName: "Grace Hopper", email: "grace@example.test", role: "moderator" },
      ],
    };
    const draft: ApplicantDraftView = {
      call: {
        name: "Synthetic call",
        slug: "synthetic-call",
        accessMode: "PUBLIC",
        state: "OPEN",
        availability: "open",
        timezone: "UTC",
        opensAt: null,
        closesAt: null,
        disclosure: {},
        choices: [],
        fields: [field],
      },
      submissionState: "DRAFT",
      currentRevisionId: "revision-co-presenters",
      fields: [{ ...field, editable: true, effective: true, value }],
      hiddenAnswerCount: 0,
      hasConsentReceipt: false,
    };

    const html = renderToStaticMarkup(createElement(ApplicantDraftForm, {
      workspace: "northstar",
      callSlug: "synthetic-call",
      draft,
      saved: false,
    }));

    expect(html).toContain("Full name");
    expect(html).toContain("answer:coPresenters");
    expect(html).toContain("ada@example.test");
    expect(html).toContain("co-speaker");
    expect(html).toContain("moderator");
    expect(html).toContain("Add co-presenter / coauthor (2/2)");
  });

  it("does not downgrade a schema-tagged nonplain config to a text field", () => {
    class TaggedConfig {
      readonly schema = CO_PRESENTERS_FIELD_CONFIG_SCHEMA;
      readonly maxEntries = 2;
      readonly roles = ["co-speaker", "moderator"];
    }
    const field = {
      id: "coPresenters",
      type: "longText" as const,
      label: "Co-presenters / coauthors",
      required: false,
      defaultVisibility: "visible" as const,
      config: new TaggedConfig(),
    };
    const draft: ApplicantDraftView = {
      call: {
        name: "Synthetic call",
        slug: "synthetic-call",
        accessMode: "PUBLIC",
        state: "OPEN",
        availability: "open",
        timezone: "UTC",
        opensAt: null,
        closesAt: null,
        disclosure: {},
        choices: [],
        fields: [field],
      },
      submissionState: "DRAFT",
      currentRevisionId: "revision-co-presenters-invalid-config",
      fields: [{ ...field, editable: true, effective: true, value: null }],
      hiddenAnswerCount: 0,
      hasConsentReceipt: false,
    } as unknown as ApplicantDraftView;

    const html = renderToStaticMarkup(createElement(ApplicantDraftForm, {
      workspace: "northstar",
      callSlug: "synthetic-call",
      draft,
      saved: false,
    }));

    expect(html).toContain("This structured question is unavailable");
    expect(html).not.toContain("name=\"answer:coPresenters\"");
    expect(html).not.toContain("Full name");
  });
});
