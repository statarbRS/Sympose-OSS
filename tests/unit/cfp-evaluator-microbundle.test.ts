import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/cfp/actions", () => ({
  saveApplicantDraftAction: vi.fn(),
  submitApplicantDraftAction: vi.fn(),
}));

import { ApplicantJourney } from "../../src/components/cfp/applicant-journey";
import {
  ApplicantDraftForm,
  ClosedDraftReadOnly,
} from "../../src/components/cfp/draft-form";
import {
  CallActions,
  CallAvailabilityPanel,
  CallHeading,
  formatApplicantDateTime,
} from "../../src/components/cfp/call-overview";
import type {
  ApplicantCallView,
  ApplicantDraftView,
} from "../../src/components/cfp/contracts";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  EVALUATOR_CALL_ID,
  EVALUATOR_FORM_VERSION_ID,
  EVALUATOR_MINA_SUBMISSION_ID,
  EVALUATOR_NOOR_SUBMISSION_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
} from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import { evaluateConditionalForm } from "../../src/server/services/cfp/form-evaluator";
import { readSubmissionRevision } from "../../src/server/services/cfp/form-documents";

let databases: Db[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
});

function closedDraft(): ApplicantDraftView {
  return {
    call: {
      name: "Stagecraft 2026 Call for Proposals",
      slug: "stagecraft-2026",
      accessMode: "PUBLIC",
      state: "CLOSED",
      availability: "closed",
      timezone: "UTC",
      opensAt: "2026-08-01T00:00:00.000Z",
      closesAt: "2026-08-10T00:00:00.000Z",
      disclosure: {},
      choices: [],
      fields: [
        {
          id: "title",
          type: "shortText",
          label: "Session title",
          required: true,
          defaultVisibility: "visible",
        },
      ],
    },
    submissionState: "DRAFT",
    currentRevisionId: "revision_closed_draft",
    fields: [
      {
        id: "title",
        type: "shortText",
        label: "Session title",
        required: true,
        editable: true,
        effective: true,
        value: "A draft retained after close",
      },
    ],
    hiddenAnswerCount: 0,
    hasConsentReceipt: false,
  };
}

function deadlineClosedCall(): ApplicantCallView {
  return {
    ...closedDraft().call,
    state: "OPEN",
    availability: "closed",
  };
}

describe("deadline-safe CFP evaluator micro-bundle", () => {
  it("renders a deadline-closed public call with state and deadline but no applicant entry routes", () => {
    const call = deadlineClosedCall();
    const baseHref = "/cfp/acme/stagecraft-2026";
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(CallHeading, { call }),
        createElement(ApplicantJourney, {
          baseHref,
          active: "overview",
          availability: call.availability,
        }),
        createElement(CallAvailabilityPanel, { call }),
        createElement(CallActions, { workspace: "acme", call }),
      ),
    );

    expect(html).toContain("Stagecraft 2026 Call for Proposals");
    expect(html).toContain("cfp-status-badge--closed");
    expect(html).toContain(
      formatApplicantDateTime(call.closesAt!, call.timezone),
    );
    expect(html).toContain(`${baseHref}/dashboard`);
    expect(html).not.toContain(`${baseHref}/verify`);
    expect(html).not.toContain(`${baseHref}/draft`);
    expect(html).not.toContain("Verify your email");
    expect(html).not.toContain("Continue a saved draft");
    expect(html).not.toContain("Build draft");
  });

  it("keeps open-call verification and draft entry controls available", () => {
    const call: ApplicantCallView = {
      ...deadlineClosedCall(),
      state: "OPEN",
      availability: "open",
      closesAt: "2027-08-10T00:00:00.000Z",
    };
    const baseHref = "/cfp/acme/stagecraft-2026";
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(ApplicantJourney, {
          baseHref,
          active: "overview",
          availability: call.availability,
        }),
        createElement(CallActions, { workspace: "acme", call }),
      ),
    );

    expect(html).toContain(`${baseHref}/verify`);
    expect(html).toContain(`${baseHref}/draft`);
    expect(html).toContain("Verify your email");
    expect(html).toContain("Continue a saved draft");
  });

  it("seeds visible Track and Format choices while retaining Workshop conditional logic", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);
    seedEvaluatorDemo(db);

    const formRow = db
      .prepare("SELECT document_json AS documentJson FROM form_versions WHERE id = ?")
      .get(EVALUATOR_FORM_VERSION_ID) as { documentJson: string };
    const form = JSON.parse(formRow.documentJson) as {
      fields: Array<{ id: string; label: string; type: string; config?: { options?: unknown[] } }>;
    };
    const track = form.fields.find((field) => field.id === "track");
    const format = form.fields.find((field) => field.id === "format");

    expect(track).toMatchObject({ id: "track", label: "Track", type: "singleChoice" });
    expect(track?.config?.options).toEqual([
      { value: "Main stage", label: "Main stage" },
      { value: "Practice rooms", label: "Practice rooms" },
    ]);
    expect(format).toMatchObject({ id: "format", label: "Format", type: "singleChoice" });

    const ruleRow = db
      .prepare("SELECT rules_json AS rulesJson FROM rule_versions WHERE form_definition_id = (SELECT form_definition_id FROM form_versions WHERE id = ?)")
      .get(EVALUATOR_FORM_VERSION_ID) as { rulesJson: string };
    const ruleSet = JSON.parse(ruleRow.rulesJson);
    const talk = evaluateConditionalForm({
      fields: form.fields,
      historicalAnswers: [{ fieldId: "format", value: "Talk" }],
      ruleSet,
    });
    const workshop = evaluateConditionalForm({
      fields: form.fields,
      historicalAnswers: [{ fieldId: "format", value: "Workshop" }],
      ruleSet,
    });
    const state = (result: typeof talk, fieldId: string) =>
      result.fieldStates.find((candidate) => candidate.fieldId === fieldId);

    expect(state(talk, "workshopPlan")).toMatchObject({
      visible: false,
      effective: false,
      required: false,
    });
    expect(state(workshop, "workshopPlan")).toMatchObject({
      visible: true,
      effective: true,
      required: true,
    });

    for (const submissionId of [EVALUATOR_MINA_SUBMISSION_ID, EVALUATOR_NOOR_SUBMISSION_ID]) {
      const row = db
        .prepare("SELECT current_revision_id AS revisionId FROM submissions WHERE id = ?")
        .get(submissionId) as { revisionId: string };
      const submission = readSubmissionRevision(
        db,
        EVALUATOR_WORKSPACE_ID,
        row.revisionId,
      );
      expect(submission.formDocument.effectiveAnswers).toEqual(
        expect.arrayContaining([expect.objectContaining({ fieldId: "track" })]),
      );
    }
    expect(
      db.prepare("SELECT state FROM calls WHERE id = ?").get(EVALUATOR_CALL_ID),
    ).toEqual({ state: "OPEN" });
  });

  it("renders an existing closed draft as read-only with dashboard access only", () => {
    const draft = closedDraft();
    const html = renderToStaticMarkup(
      createElement(ApplicantDraftForm, {
        workspace: "acme",
        callSlug: "stagecraft-2026",
        draft,
        saved: false,
      }),
    );

    expect(html).toContain('data-testid="applicant-closed-draft"');
    expect(html).toContain("A draft retained after close");
    expect(html).toContain("Open applicant dashboard");
    expect(html).toContain("/cfp/acme/stagecraft-2026/dashboard");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Save draft");
    expect(html).not.toContain("Submit saved revision");
    expect(html).not.toContain("Create or resume draft");
    expect(html).not.toContain("Verify your email");
  });

  it("keeps the closed read-only primitive free of applicant mutation controls", () => {
    const html = renderToStaticMarkup(
      createElement(ClosedDraftReadOnly, {
        draft: closedDraft(),
        dashboardHref: "/cfp/acme/stagecraft-2026/dashboard",
      }),
    );

    expect(html).toContain("Applications are closed");
    expect(html).toContain("immutable revision");
    expect(html).not.toContain("action=");
    expect(html).not.toContain("type=\"submit\"");
  });
});
