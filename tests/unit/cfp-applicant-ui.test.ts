import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PortalError extends Error {
    readonly code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }

  class PortalFatalError extends Error {
    readonly fatal = true;

    constructor() {
      super("fatal applicant portal boundary");
      this.name = "CfpApplicantPortalFatalError";
    }
  }

  class SubmissionFatalError extends Error {
    readonly fatal = true;

    constructor() {
      super("fatal submission command boundary");
      this.name = "CfpSubmissionCommandFatalError";
    }
  }

  const cookieValues = new Map<string, string>();
  const cookieStore = {
    get: vi.fn((name: string) => {
      const value = cookieValues.get(name);
      return value === undefined ? undefined : { name, value };
    }),
    set: vi.fn((name: string, value: string, _options?: Readonly<Record<string, unknown>>) => {
      cookieValues.set(name, value);
    }),
    delete: vi.fn((name: string) => {
      cookieValues.delete(name);
    }),
  };

  let activeDb: { readonly portalTestDb: number } = { portalTestDb: 1 };
  const getDb = vi.fn(() => activeDb);
  const closeDb = vi.fn((db: { readonly portalTestDb: number }) => {
    if (db === activeDb) activeDb = { portalTestDb: activeDb.portalTestDb + 1 };
  });
  const deliveryPort = {
    prepareForRequest: vi.fn(),
    deliver: vi.fn(),
  };

  return {
    PortalError,
    PortalFatalError,
    SubmissionFatalError,
    cookieValues,
    cookieStore,
    cookies: vi.fn(async () => cookieStore),
    redirect: vi.fn((destination: string): never => {
      throw new Error(`TEST_REDIRECT:${destination}`);
    }),
    getDb,
    closeDb,
    activeDb: () => activeDb,
    resetDb: () => {
      activeDb = { portalTestDb: 1 };
    },
    getWorkspaceBySlug: vi.fn(),
    locateCall: vi.fn(),
    requestVerification: vi.fn(),
    deliveryPort,
    getDeliveryPort: vi.fn(),
    consumeVerification: vi.fn(),
    readCurrent: vi.fn(),
    createDraft: vi.fn(),
    saveDraft: vi.fn(),
    submitDraft: vi.fn(),
  };
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/db", () => ({ getDb: mocks.getDb, closeDb: mocks.closeDb }));
vi.mock("@/server/services/queries", () => ({
  getWorkspaceBySlug: mocks.getWorkspaceBySlug,
}));
vi.mock("@/server/services/cfp/applicant-portal", () => ({
  CfpApplicantPortalFatalError: mocks.PortalFatalError,
  CfpApplicantPortalError: mocks.PortalError,
  locateExternallyReachableCall: mocks.locateCall,
  issueApplicantEmailVerificationForDelivery: mocks.requestVerification,
  consumeApplicantEmailVerification: mocks.consumeVerification,
  readApplicantOwnedCurrentRevision: mocks.readCurrent,
  createApplicantSubmissionDraft: mocks.createDraft,
  saveApplicantSubmissionDraft: mocks.saveDraft,
  submitApplicantSubmission: mocks.submitDraft,
}));
vi.mock("@/app/cfp/verification-delivery.server", () => ({
  getApplicantVerificationDeliveryPort: mocks.getDeliveryPort,
}));
vi.mock("@/server/services/cfp/submissions", () => ({
  CfpSubmissionCommandFatalError: mocks.SubmissionFatalError,
}));

import {
  createApplicantDraftAction,
  consumeApplicantVerificationAction,
  loadApplicantDraftPage,
  loadApplicantVerificationPage,
  requestApplicantVerificationAction,
  saveApplicantDraftAction,
  submitApplicantDraftAction,
} from "../../src/app/cfp/actions";
import { GET as consumeLink } from "../../src/app/cfp/[workspace]/[callSlug]/access/route";
import {
  CallAvailabilityPanel,
  CallActions,
  CallHeading,
  Disclosure,
  FormPreview,
} from "../../src/components/cfp/call-overview";
import {
  ApplicantDraftForm,
  SubmissionReceipt,
} from "../../src/components/cfp/draft-form";
import {
  CO_PRESENTERS_FIELD_CONFIG_SCHEMA,
  CO_PRESENTERS_VALUE_SCHEMA,
} from "../../src/cfp/co-presenters";
import {
  IDLE_APPLICANT_ACTION_STATE,
  applicantActionRequiresReload,
  type ApplicantCallView,
  type ApplicantDraftView,
} from "../../src/components/cfp/contracts";

const WORKSPACE = "northstar";
const CALL_SLUG = "community-stage";
const SESSION_TOKEN = "s".repeat(43);
const SUBMISSION_ID = "submission_applicant_1";
const REVISION_ID = "revision_applicant_1";

const publicProjection = {
  callId: "call_applicant_1",
  name: "Community Stage 2027",
  slug: CALL_SLUG,
  accessMode: "PUBLIC" as const,
  state: "OPEN" as const,
  timezone: "UTC",
  opensAt: "2026-08-01T00:00:00.000Z",
  closesAt: "2027-12-31T23:59:59.000Z",
  disclosure: {
    privacy: "Only the event team can administer the application.",
    retention: "Application records are retained for one year.",
    aiProcessing: "No AI processing is used in this call.",
    communication: "The organizer may email about this application.",
    consent: "Required acknowledgements are recorded with the revision.",
    publication: "Accepted proposal details may be published.",
  },
  choices: [
    {
      fieldId: "privacy_ack",
      statement: "I accept the applicant privacy notice.",
      required: true,
    },
  ],
  fields: [
    {
      id: "title",
      type: "shortText" as const,
      label: "Proposal title",
      required: true,
      defaultVisibility: "visible" as const,
      config: { guidance: "Use a clear, descriptive title." },
    },
    {
      id: "format",
      type: "singleChoice" as const,
      label: "Session format",
      required: true,
      defaultVisibility: "visible" as const,
      config: { options: ["Talk", "Workshop"] },
    },
    {
      id: "workshop_plan",
      type: "longText" as const,
      label: "Workshop plan",
      required: true,
      defaultVisibility: "hidden" as const,
    },
    {
      id: "privacy_ack",
      type: "consent" as const,
      label: "Privacy acknowledgement",
      required: true,
      defaultVisibility: "visible" as const,
    },
  ],
};

const draftProjection = {
  call: {
    callId: publicProjection.callId,
    name: publicProjection.name,
    slug: publicProjection.slug,
    accessMode: publicProjection.accessMode,
    state: publicProjection.state,
    timezone: publicProjection.timezone,
    opensAt: publicProjection.opensAt,
    closesAt: publicProjection.closesAt,
  },
  submissionId: SUBMISSION_ID,
  submissionState: "DRAFT" as const,
  currentRevisionId: REVISION_ID,
  fields: publicProjection.fields,
  historicalAnswers: [
    { fieldId: "title", value: "Earlier title" },
    { fieldId: "format", value: "Talk" },
    { fieldId: "workshop_plan", value: "Retained private workshop history" },
    { fieldId: "abstract", value: "An abstract that is ready to submit." },
    { fieldId: "privacy_ack", value: true },
  ],
  effectiveAnswers: [
    { fieldId: "title", value: "Earlier title" },
    { fieldId: "format", value: "Talk" },
    { fieldId: "abstract", value: "An abstract that is ready to submit." },
    { fieldId: "privacy_ack", value: true },
  ],
  presentationState: {
    fieldStates: [
      { fieldId: "title", visible: true, effective: true, editable: true, required: true, skipped: false },
      { fieldId: "format", visible: true, effective: true, editable: true, required: true, skipped: false },
      {
        fieldId: "workshop_plan",
        visible: false,
        effective: false,
        editable: false,
        required: false,
        skipped: false,
      },
      {
        fieldId: "privacy_ack",
        visible: true,
        effective: true,
        editable: true,
        required: true,
        skipped: false,
      },
    ],
    hiddenFieldIds: ["workshop_plan"],
    disabledFieldIds: [],
    requiredFieldIds: ["title", "format", "abstract", "privacy_ack"],
    skippedFieldIds: [],
  },
  disclosure: publicProjection.disclosure,
  choices: publicProjection.choices,
  hasConsentReceipt: true,
};

function encodeCookie(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function scopedCookieName(prefix: string, workspace = WORKSPACE, call = CALL_SLUG): string {
  const scope = createHash("sha256").update(`${workspace}\u0000${call}`).digest("hex").slice(0, 24);
  return `${prefix}_${scope}`;
}

function establishApplicantSessionCookieScope(): void {
  mocks.cookieValues.set(
    scopedCookieName("sympose_cfp_applicant"),
    encodeCookie({ version: 1, workspace: WORKSPACE, call: CALL_SLUG, token: SESSION_TOKEN }),
  );
}

function establishOwnedDraftCookieScope(): void {
  establishApplicantSessionCookieScope();
  mocks.cookieValues.set(
    scopedCookieName("sympose_cfp_submission"),
    encodeCookie({
      version: 1,
      workspace: WORKSPACE,
      call: CALL_SLUG,
      submissionId: SUBMISSION_ID,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resetDb();
  mocks.cookieValues.clear();
  mocks.getWorkspaceBySlug.mockReturnValue({ id: "workspace_northstar", slug: WORKSPACE });
  mocks.locateCall.mockReturnValue({ available: true, call: publicProjection });
  mocks.requestVerification.mockReturnValue({
    accepted: true,
    verificationId: "verification_requested_1",
    expiresAt: "2026-08-11T12:49:56.000Z",
  });
  mocks.getDeliveryPort.mockReturnValue(mocks.deliveryPort);
  mocks.deliveryPort.prepareForRequest.mockResolvedValue(undefined);
  mocks.deliveryPort.deliver.mockResolvedValue(undefined);
  mocks.consumeVerification.mockReturnValue({
    success: true,
    expiresAt: "2026-08-25T00:00:00.000Z",
  });
  mocks.readCurrent.mockReturnValue({ found: true, draft: draftProjection });
  mocks.createDraft.mockReturnValue({ submissionId: SUBMISSION_ID });
  mocks.saveDraft.mockReturnValue({
    submissionId: SUBMISSION_ID,
    revisionId: "revision_applicant_2",
    hasConsentReceipt: true,
  });
  mocks.submitDraft.mockReturnValue({
    submissionId: SUBMISSION_ID,
    revisionId: "revision_applicant_2",
    submittedAt: "2026-08-11T12:34:56.000Z",
  });
});

describe("CFP applicant UI", () => {
  it("renders the public call status, exact disclosure, and pinned question preview", () => {
    const call: ApplicantCallView = {
      name: publicProjection.name,
      slug: publicProjection.slug,
      accessMode: publicProjection.accessMode,
      state: publicProjection.state,
      availability: "open",
      timezone: publicProjection.timezone,
      opensAt: publicProjection.opensAt,
      closesAt: publicProjection.closesAt,
      disclosure: publicProjection.disclosure,
      choices: publicProjection.choices,
      fields: publicProjection.fields,
    };

    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(CallHeading, { call }),
        createElement(Disclosure, { call }),
        createElement(FormPreview, { call }),
      ),
    );

    expect(html).toContain("Community Stage 2027");
    expect(html).toContain("Open");
    expect(html).toContain("No AI processing is used in this call.");
    expect(html).toContain("Workshop plan");
    expect(html).toContain("Conditional");
  });

  it("renders stable scheduled, paused, and closed call states in words", () => {
    const base: ApplicantCallView = {
      name: publicProjection.name,
      slug: publicProjection.slug,
      accessMode: publicProjection.accessMode,
      state: "OPEN",
      availability: "open",
      timezone: publicProjection.timezone,
      opensAt: publicProjection.opensAt,
      closesAt: publicProjection.closesAt,
      disclosure: publicProjection.disclosure,
      choices: publicProjection.choices,
      fields: publicProjection.fields,
    };
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(CallAvailabilityPanel, {
          call: { ...base, state: "SCHEDULED", availability: "scheduled" },
        }),
        createElement(CallAvailabilityPanel, {
          call: { ...base, state: "PAUSED", availability: "paused" },
        }),
        createElement(CallAvailabilityPanel, {
          call: { ...base, state: "CLOSED", availability: "closed" },
        }),
        createElement(CallActions, {
          workspace: WORKSPACE,
          call: { ...base, state: "CLOSED", availability: "closed" },
        }),
      ),
    );

    expect(html).toContain("not open yet");
    expect(html).toContain("Applications are paused");
    expect(html).toContain("This call is closed");
    expect(html).toContain("New submissions and ordinary draft changes are unavailable");
    expect(html).toContain("View applicant dashboard");
    expect(html).not.toContain("Verify your email");
    expect(html).not.toContain("Continue a saved draft");
  });

  it("keeps hidden history out of rendered data while disclosing only its count", () => {
    const draft: ApplicantDraftView = {
      call: {
        name: publicProjection.name,
        slug: publicProjection.slug,
        accessMode: publicProjection.accessMode,
        state: publicProjection.state,
        availability: "open",
        timezone: publicProjection.timezone,
        opensAt: publicProjection.opensAt,
        closesAt: publicProjection.closesAt,
        disclosure: publicProjection.disclosure,
        choices: publicProjection.choices,
        fields: publicProjection.fields,
      },
      submissionState: "DRAFT",
      currentRevisionId: REVISION_ID,
      fields: [
        {
          id: "title",
          type: "shortText",
          label: "Proposal title",
          required: true,
          editable: true,
          effective: true,
          value: "Earlier title",
        },
      ],
      hiddenAnswerCount: 1,
      hasConsentReceipt: false,
    };

    const html = renderToStaticMarkup(
      createElement(ApplicantDraftForm, {
        workspace: WORKSPACE,
        callSlug: CALL_SLUG,
        draft,
        saved: false,
      }),
    );

    expect(html).toContain("1 answer is currently hidden");
    expect(html).toContain("Earlier title");
    expect(html).not.toContain("Retained private workshop history");
    expect(html).not.toContain(SESSION_TOKEN);
  });

  it("renders and persists a required ranking in its exact submitted order", async () => {
    const rankingOptions = [
      { value: "talk", label: "Talk" },
      { value: "workshop", label: "Workshop" },
      { value: "panel", label: "Panel" },
    ];
    const rankingField = {
      id: "format_ranking",
      type: "ranking" as const,
      label: "Rank session formats",
      required: true,
      defaultVisibility: "visible" as const,
      config: { options: rankingOptions },
    };
    const rankingView: ApplicantDraftView = {
      call: {
        name: publicProjection.name,
        slug: publicProjection.slug,
        accessMode: publicProjection.accessMode,
        state: publicProjection.state,
        availability: "open",
        timezone: publicProjection.timezone,
        opensAt: publicProjection.opensAt,
        closesAt: publicProjection.closesAt,
        disclosure: publicProjection.disclosure,
        choices: [],
        fields: [rankingField],
      },
      submissionState: "DRAFT",
      currentRevisionId: REVISION_ID,
      fields: [
        {
          ...rankingField,
          editable: true,
          effective: true,
          value: ["workshop", "talk", "panel"],
        },
      ],
      hiddenAnswerCount: 0,
      hasConsentReceipt: false,
    };

    const html = renderToStaticMarkup(
      createElement(ApplicantDraftForm, {
        workspace: WORKSPACE,
        callSlug: CALL_SLUG,
        draft: rankingView,
        saved: false,
      }),
    );
    expect(html).toContain("The first option is ranked highest");
    expect(html).toContain("Move Workshop down");
    expect(html.indexOf('value="workshop"')).toBeLessThan(html.indexOf('value="talk"'));
    expect(html.indexOf('value="talk"')).toBeLessThan(html.indexOf('value="panel"'));

    const rankingProjection = {
      ...draftProjection,
      fields: [rankingField],
      historicalAnswers: [],
      effectiveAnswers: [],
      presentationState: {
        fieldStates: [
          {
            fieldId: rankingField.id,
            visible: true,
            effective: true,
            editable: true,
            required: true,
            skipped: false,
          },
        ],
        hiddenFieldIds: [],
        disabledFieldIds: [],
        requiredFieldIds: [rankingField.id],
        skippedFieldIds: [],
      },
      choices: [],
      hasConsentReceipt: false,
    };
    establishOwnedDraftCookieScope();
    mocks.readCurrent.mockReturnValue({ found: true, draft: rankingProjection });
    const formData = new FormData();
    formData.append("answer:format_ranking", "panel");
    formData.append("answer:format_ranking", "workshop");
    formData.append("answer:format_ranking", "talk");

    await expect(
      saveApplicantDraftAction(
        WORKSPACE,
        CALL_SLUG,
        REVISION_ID,
        IDLE_APPLICANT_ACTION_STATE,
        formData,
      ),
    ).rejects.toThrow("TEST_REDIRECT:/cfp/northstar/community-stage/draft?saved=1");
    const saveInput = mocks.saveDraft.mock.calls.at(-1)?.[1] as {
      historicalAnswers: readonly { fieldId: string; value: unknown }[];
    };
    expect(saveInput.historicalAnswers).toEqual([
      { fieldId: "format_ranking", value: ["panel", "workshop", "talk"] },
    ]);

    const savedRankingProjection = {
      ...rankingProjection,
      historicalAnswers: saveInput.historicalAnswers,
      effectiveAnswers: saveInput.historicalAnswers,
    };
    mocks.readCurrent.mockReturnValue({ found: true, draft: savedRankingProjection });
    const submitted = await submitApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    expect(submitted.kind).toBe("submitted");
    expect(mocks.submitDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ historicalAnswers: saveInput.historicalAnswers }),
    );
  });

  it("preserves hidden historical answers on save and never trusts a posted hidden value", async () => {
    establishOwnedDraftCookieScope();
    const formData = new FormData();
    formData.set("answer:title", "Updated title");
    formData.set("answer:format", "Talk");
    formData.set("answer:workshop_plan", "Attempted overwrite");
    formData.set("answer:privacy_ack", "true");

    await expect(
      saveApplicantDraftAction(
        WORKSPACE,
        CALL_SLUG,
        REVISION_ID,
        IDLE_APPLICANT_ACTION_STATE,
        formData,
      ),
    ).rejects.toThrow("TEST_REDIRECT:/cfp/northstar/community-stage/draft?saved=1");

    const input = mocks.saveDraft.mock.calls[0]?.[1] as {
      historicalAnswers: readonly { fieldId: string; value: unknown }[];
      expectedCurrentRevisionId: string;
    };
    expect(input.expectedCurrentRevisionId).toBe(REVISION_ID);
    expect(input.historicalAnswers).toContainEqual({
      fieldId: "workshop_plan",
      value: "Retained private workshop history",
    });
    expect(input.historicalAnswers).not.toContainEqual({
      fieldId: "workshop_plan",
      value: "Attempted overwrite",
    });
  });

  it("requires explicit stale reconciliation and never writes over the newer pointer", async () => {
    establishOwnedDraftCookieScope();
    mocks.readCurrent.mockReturnValue({
      found: true,
      draft: { ...draftProjection, currentRevisionId: "revision_applicant_winner" },
    });

    const state = await saveApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );

    expect(state.kind).toBe("stale");
    expect(state.message).toContain("explicitly reconcile");
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });

  it.each([
    ["portal", () => new mocks.PortalFatalError()],
    ["submission", () => Object.freeze(new mocks.SubmissionFatalError())],
  ])("propagates a genuine %s fatal stop and retires its exact connection", async (_label, fatalFactory) => {
    establishOwnedDraftCookieScope();
    const activeDb = mocks.activeDb();
    const fatal = fatalFactory();
    mocks.saveDraft.mockImplementationOnce(() => {
      throw fatal;
    });

    await expect(
      saveApplicantDraftAction(
        WORKSPACE,
        CALL_SLUG,
        REVISION_ID,
        IDLE_APPLICANT_ACTION_STATE,
        new FormData(),
      ),
    ).rejects.toBe(fatal);

    expect(mocks.closeDb).toHaveBeenCalledOnce();
    expect(mocks.closeDb).toHaveBeenCalledWith(activeDb);
    expect(mocks.activeDb()).not.toBe(activeDb);
  });

  it("persists an indeterminate-create hold across reload and suppresses duplicate creation", async () => {
    establishApplicantSessionCookieScope();
    mocks.createDraft.mockImplementationOnce(() => {
      throw new mocks.PortalError("PORTAL_WRITE_INDETERMINATE");
    });
    const createState = await createApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    expect(createState).toMatchObject({ kind: "stale", code: "RESULT_UNCONFIRMED" });
    expect(applicantActionRequiresReload(createState)).toBe(true);
    const heldCookieName = [...mocks.cookieValues.keys()].find((name) =>
      name.startsWith("sympose_cfp_create_hold_"));
    expect(heldCookieName).toBeDefined();

    const reloaded = await loadApplicantDraftPage(WORKSPACE, CALL_SLUG);
    expect(reloaded).toMatchObject({ kind: "creation-unconfirmed" });
    expect(mocks.readCurrent).not.toHaveBeenCalled();

    const retryState = await createApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    expect(retryState).toMatchObject({
      kind: "stale",
      code: "DRAFT_CREATION_UNCONFIRMED",
    });
    expect(mocks.createDraft).toHaveBeenCalledOnce();
  });

  it("keeps pending verification, session, and an unconfirmed hold isolated from other-call work", async () => {
    establishApplicantSessionCookieScope();
    const callASessionCookie = scopedCookieName("sympose_cfp_applicant");
    const callASession = mocks.cookieValues.get(callASessionCookie);
    mocks.createDraft.mockImplementationOnce(() => {
      throw new mocks.PortalError("PORTAL_WRITE_INDETERMINATE");
    });
    await createApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    const callAHold = [...mocks.cookieValues.keys()].find((name) =>
      name.startsWith("sympose_cfp_create_hold_"));
    expect(callAHold).toBeDefined();
    const callAVerificationCookie = scopedCookieName("sympose_cfp_verification");
    const callAVerification = encodeCookie({
      version: 1,
      workspace: WORKSPACE,
      call: CALL_SLUG,
      verificationId: "verification_community_stage",
      token: "a".repeat(43),
    });
    mocks.cookieValues.set(callAVerificationCookie, callAVerification);

    const otherCall = "second-stage";
    const otherVerificationCookie = scopedCookieName(
      "sympose_cfp_verification",
      WORKSPACE,
      otherCall,
    );
    mocks.cookieValues.set(
      otherVerificationCookie,
      encodeCookie({
        version: 1,
        workspace: WORKSPACE,
        call: otherCall,
        verificationId: "verification_second_stage",
        token: "b".repeat(43),
      }),
    );
    mocks.locateCall.mockReturnValue({
      available: true,
      call: { ...publicProjection, callId: "call_applicant_2", slug: otherCall },
    });
    const verificationData = new FormData();
    verificationData.set("fullName", "Second Stage Applicant");
    await expect(
      consumeApplicantVerificationAction(
        WORKSPACE,
        otherCall,
        IDLE_APPLICANT_ACTION_STATE,
        verificationData,
      ),
    ).rejects.toThrow(`TEST_REDIRECT:/cfp/${WORKSPACE}/${otherCall}/draft`);
    expect(
      mocks.cookieValues.get(scopedCookieName("sympose_cfp_applicant", WORKSPACE, otherCall)),
    ).toBeTruthy();

    mocks.createDraft.mockReturnValueOnce({ submissionId: "submission_applicant_2" });
    mocks.saveDraft.mockReturnValueOnce({ revisionId: "revision_applicant_2" });
    await expect(
      createApplicantDraftAction(
        WORKSPACE,
        otherCall,
        IDLE_APPLICANT_ACTION_STATE,
        new FormData(),
      ),
    ).rejects.toThrow(`TEST_REDIRECT:/cfp/${WORKSPACE}/${otherCall}/draft?saved=1`);
    expect(mocks.cookieValues.get(callAHold!)).toBeTruthy();

    mocks.cookieValues.set(
      otherVerificationCookie,
      encodeCookie({
        version: 1,
        workspace: WORKSPACE,
        call: CALL_SLUG,
        verificationId: "verification_wrong_scope",
        token: "c".repeat(43),
      }),
    );
    const invalid = await consumeApplicantVerificationAction(
      WORKSPACE,
      otherCall,
      IDLE_APPLICANT_ACTION_STATE,
      verificationData,
    );
    expect(invalid).toMatchObject({ kind: "error", code: "VERIFICATION_LINK_INVALID" });
    expect(mocks.cookieValues.get(otherVerificationCookie)).toBe("");
    expect(mocks.cookieValues.get(callAVerificationCookie)).toBe(callAVerification);
    expect(mocks.cookieValues.get(callASessionCookie)).toBe(callASession);
    expect(mocks.cookieValues.get(callAHold!)).toBeTruthy();

    mocks.locateCall.mockReturnValue({ available: true, call: publicProjection });
    await expect(loadApplicantVerificationPage(WORKSPACE, CALL_SLUG)).resolves.toMatchObject({
      hasPendingVerification: true,
    });
    await expect(loadApplicantDraftPage(WORKSPACE, CALL_SLUG)).resolves.toMatchObject({
      kind: "creation-unconfirmed",
    });
  });

  it("keeps a confirmed-create recovery pointer across indeterminate initial save and other-call work", async () => {
    establishApplicantSessionCookieScope();
    const callASessionCookie = scopedCookieName("sympose_cfp_applicant");
    const callASession = mocks.cookieValues.get(callASessionCookie);
    const callAVerificationCookie = scopedCookieName("sympose_cfp_verification");
    const callAVerification = encodeCookie({
      version: 1,
      workspace: WORKSPACE,
      call: CALL_SLUG,
      verificationId: "verification_community_stage",
      token: "a".repeat(43),
    });
    mocks.cookieValues.set(callAVerificationCookie, callAVerification);
    mocks.saveDraft.mockImplementationOnce(() => {
      throw new mocks.PortalError("PORTAL_WRITE_INDETERMINATE");
    });
    const state = await createApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    expect(state).toMatchObject({ kind: "stale", code: "RESULT_UNCONFIRMED" });

    const callASubmissionCookie = scopedCookieName("sympose_cfp_submission");
    expect(mocks.cookieValues.get(callASubmissionCookie)).toBeTruthy();
    const pointerWrite = mocks.cookieStore.set.mock.calls.find(
      ([name, value]) => name === callASubmissionCookie && value !== "",
    );
    expect(pointerWrite?.[2]).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/cfp",
      maxAge: 400 * 24 * 60 * 60,
    });

    const otherCall = "second-stage";
    mocks.locateCall.mockReturnValue({
      available: true,
      call: { ...publicProjection, callId: "call_applicant_2", slug: otherCall },
    });
    mocks.cookieValues.set(
      scopedCookieName("sympose_cfp_verification", WORKSPACE, otherCall),
      encodeCookie({
        version: 1,
        workspace: WORKSPACE,
        call: otherCall,
        verificationId: "verification_second_stage",
        token: "v".repeat(43),
      }),
    );
    const verificationData = new FormData();
    verificationData.set("fullName", "Second Stage Applicant");
    await expect(
      consumeApplicantVerificationAction(
        WORKSPACE,
        otherCall,
        IDLE_APPLICANT_ACTION_STATE,
        verificationData,
      ),
    ).rejects.toThrow(`TEST_REDIRECT:/cfp/${WORKSPACE}/${otherCall}/draft`);
    expect(mocks.cookieValues.get(callASubmissionCookie)).toBeTruthy();

    mocks.createDraft.mockReturnValueOnce({ submissionId: "submission_applicant_2" });
    await expect(
      createApplicantDraftAction(
        WORKSPACE,
        otherCall,
        IDLE_APPLICANT_ACTION_STATE,
        new FormData(),
      ),
    ).rejects.toThrow(`TEST_REDIRECT:/cfp/${WORKSPACE}/${otherCall}/draft?saved=1`);
    expect(mocks.cookieValues.get(callASubmissionCookie)).toBeTruthy();

    expect(mocks.cookieValues.get(callASessionCookie)).toBe(callASession);
    expect(mocks.cookieValues.get(callAVerificationCookie)).toBe(callAVerification);
    mocks.locateCall.mockReturnValue({ available: true, call: publicProjection });
    await expect(loadApplicantVerificationPage(WORKSPACE, CALL_SLUG)).resolves.toMatchObject({
      hasPendingVerification: true,
    });
    const recovered = await loadApplicantDraftPage(WORKSPACE, CALL_SLUG);
    expect(recovered).toMatchObject({ kind: "draft" });
    expect(mocks.readCurrent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ submissionId: SUBMISSION_ID }),
    );
  });

  it("makes an indeterminate save outcome reload-required instead of retryable", async () => {
    establishOwnedDraftCookieScope();
    mocks.saveDraft.mockImplementationOnce(() => {
      throw new mocks.PortalError("PORTAL_WRITE_INDETERMINATE");
    });
    const saveState = await saveApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    expect(saveState).toMatchObject({ kind: "stale", code: "RESULT_UNCONFIRMED" });
    expect(saveState.message).toContain("authoritative draft");
    expect(applicantActionRequiresReload(saveState)).toBe(true);
  });

  it("turns authoritative save and submit terminal conflicts into reload-required states", async () => {
    establishOwnedDraftCookieScope();
    mocks.saveDraft.mockImplementationOnce(() => {
      throw new mocks.PortalError("SUBMISSION_NOT_DRAFT");
    });
    const saveState = await saveApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    expect(saveState).toMatchObject({ kind: "stale", code: "SUBMISSION_NOT_EDITABLE" });
    expect(applicantActionRequiresReload(saveState)).toBe(true);

    mocks.submitDraft.mockImplementationOnce(() => {
      throw new mocks.PortalError("SUBMISSION_NOT_DRAFT");
    });
    const submitState = await submitApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    expect(submitState).toMatchObject({ kind: "stale", code: "SUBMISSION_TERMINAL" });
    expect(applicantActionRequiresReload(submitState)).toBe(true);
  });

  it("fails a foreign scoped cookie closed without revealing a workspace or submission", async () => {
    const legacySession = encodeCookie({
      version: 1,
      workspace: WORKSPACE,
      call: CALL_SLUG,
      token: SESSION_TOKEN,
    });
    mocks.cookieValues.set("sympose_cfp_applicant", legacySession);
    mocks.cookieValues.set(
      scopedCookieName("sympose_cfp_applicant"),
      encodeCookie({ version: 1, workspace: "another-workspace", call: CALL_SLUG, token: SESSION_TOKEN }),
    );
    mocks.cookieValues.set(
      scopedCookieName("sympose_cfp_submission"),
      encodeCookie({
        version: 1,
        workspace: WORKSPACE,
        call: CALL_SLUG,
        submissionId: SUBMISSION_ID,
      }),
    );

    const state = await saveApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );

    expect(state.kind).toBe("error");
    expect(state.message).toBe(
      "Your applicant session is unavailable. Your answers remain in this form; verify again before retrying.",
    );
    expect(JSON.stringify(state)).not.toContain(SUBMISSION_ID);
    expect(mocks.readCurrent).not.toHaveBeenCalled();
    expect(mocks.cookieValues.get("sympose_cfp_applicant")).toBe(legacySession);
  });

  it("surfaces an incomplete saved revision without attempting submission", async () => {
    establishOwnedDraftCookieScope();
    mocks.readCurrent.mockReturnValue({
      found: true,
      draft: {
        ...draftProjection,
        historicalAnswers: [
          { fieldId: "title", value: "Earlier title" },
          { fieldId: "format", value: "Talk" },
          { fieldId: "abstract", value: null },
          { fieldId: "privacy_ack", value: false },
        ],
        effectiveAnswers: [
          { fieldId: "title", value: "Earlier title" },
          { fieldId: "format", value: "Talk" },
          { fieldId: "abstract", value: null },
          { fieldId: "privacy_ack", value: false },
        ],
        hasConsentReceipt: false,
      },
    });

    const state = await submitApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );

    if (state.kind !== "error") throw new Error("expected an incomplete submission error");
    expect(state.code).toBe("SUBMISSION_INCOMPLETE");
    expect(state.fieldErrors).toEqual({
      abstract: "Complete this required question.",
      privacy_ack: "Accept this required acknowledgement.",
    });
    expect(mocks.submitDraft).not.toHaveBeenCalled();
  });

  it("treats empty structured co-presenters as incomplete for required and conditional-required fields", async () => {
    const emptyValue = {
      schema: CO_PRESENTERS_VALUE_SCHEMA,
      entries: [],
    };
    const makeDraft = (fieldRequired: boolean) => ({
      ...draftProjection,
      fields: [{
        id: "coPresenters",
        type: "longText" as const,
        label: "Co-presenters / coauthors",
        required: fieldRequired,
        defaultVisibility: "visible" as const,
        config: {
          schema: CO_PRESENTERS_FIELD_CONFIG_SCHEMA,
          maxEntries: 2,
          roles: ["co-speaker", "moderator"],
        },
      }],
      historicalAnswers: [{ fieldId: "coPresenters", value: emptyValue }],
      effectiveAnswers: [{ fieldId: "coPresenters", value: emptyValue }],
      presentationState: {
        fieldStates: [{
          fieldId: "coPresenters",
          visible: true,
          effective: true,
          editable: true,
          required: true,
          skipped: false,
        }],
        hiddenFieldIds: [],
        disabledFieldIds: [],
        requiredFieldIds: ["coPresenters"],
        skippedFieldIds: [],
      },
      choices: [],
      hasConsentReceipt: false,
    });

    establishOwnedDraftCookieScope();
    mocks.readCurrent.mockReturnValueOnce({ found: true, draft: makeDraft(true) });
    const requiredState = await submitApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    if (requiredState.kind !== "error") throw new Error("expected an incomplete required submission");
    expect(requiredState).toMatchObject({ kind: "error", code: "SUBMISSION_INCOMPLETE" });
    expect(requiredState.fieldErrors).toEqual({ coPresenters: "Complete this required question." });
    expect(mocks.submitDraft).not.toHaveBeenCalled();

    mocks.readCurrent.mockReturnValueOnce({ found: true, draft: makeDraft(false) });
    const conditionalState = await submitApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    if (conditionalState.kind !== "error") throw new Error("expected an incomplete conditional submission");
    expect(conditionalState).toMatchObject({ kind: "error", code: "SUBMISSION_INCOMPLETE" });
    expect(conditionalState.fieldErrors).toEqual({ coPresenters: "Complete this required question." });
    expect(mocks.submitDraft).not.toHaveBeenCalled();
  });

  it("preserves co-presenter FormData encoding and allows an optional empty value to be omitted", async () => {
    const coPresentersField = {
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
    const coPresentersProjection = {
      ...draftProjection,
      fields: [coPresentersField],
      historicalAnswers: [],
      effectiveAnswers: [],
      presentationState: {
        fieldStates: [{
          fieldId: "coPresenters",
          visible: true,
          effective: true,
          editable: true,
          required: false,
          skipped: false,
        }],
        hiddenFieldIds: [],
        disabledFieldIds: [],
        requiredFieldIds: [],
        skippedFieldIds: [],
      },
      choices: [],
      hasConsentReceipt: false,
    };
    establishOwnedDraftCookieScope();
    mocks.readCurrent.mockReturnValue({ found: true, draft: coPresentersProjection });

    const value = JSON.stringify({
      schema: CO_PRESENTERS_VALUE_SCHEMA,
      entries: [{ fullName: "Ada Lovelace", email: "ada@example.test", role: "co-speaker" }],
    });
    const formData = new FormData();
    formData.set("answer:coPresenters", value);
    await expect(
      saveApplicantDraftAction(
        WORKSPACE,
        CALL_SLUG,
        REVISION_ID,
        IDLE_APPLICANT_ACTION_STATE,
        formData,
      ),
    ).rejects.toThrow("TEST_REDIRECT:/cfp/northstar/community-stage/draft?saved=1");
    expect(mocks.saveDraft.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      historicalAnswers: [{ fieldId: "coPresenters", value }],
    }));

    mocks.saveDraft.mockClear();
    const emptyFormData = new FormData();
    emptyFormData.set("answer:coPresenters", "");
    await expect(
      saveApplicantDraftAction(
        WORKSPACE,
        CALL_SLUG,
        REVISION_ID,
        IDLE_APPLICANT_ACTION_STATE,
        emptyFormData,
      ),
    ).rejects.toThrow("TEST_REDIRECT:/cfp/northstar/community-stage/draft?saved=1");
    expect(mocks.saveDraft.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      historicalAnswers: [{ fieldId: "coPresenters", value: null }],
    }));
  });

  it("submits only the exact current server-read revision and returns its bound receipt", async () => {
    establishOwnedDraftCookieScope();

    const state = await submitApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );

    expect(mocks.submitDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        submissionId: SUBMISSION_ID,
        expectedCurrentRevisionId: REVISION_ID,
        historicalAnswers: draftProjection.historicalAnswers,
      }),
    );
    expect(state).toEqual({
      kind: "submitted",
      code: "SUBMISSION_RECEIVED",
      message: "Your exact latest saved revision was submitted.",
      receipt: {
        submissionId: SUBMISSION_ID,
        revisionId: "revision_applicant_2",
        submittedAt: "2026-08-11T12:34:56.000Z",
      },
    });

    const receiptHtml = renderToStaticMarkup(
      createElement(SubmissionReceipt, {
        receipt: state.kind === "submitted" ? state.receipt : neverReceipt(),
        timezone: "UTC",
      }),
    );
    expect(receiptHtml).toContain("Immutable submission receipt");
    expect(receiptHtml).toContain("revision_applicant_2");
    expect(receiptHtml).toContain("2026-08-11T12:34:56.000Z");
  });

  it("delegates closed-call late verification and draft authority to the applicant portal", async () => {
    const closedProjection = {
      ...publicProjection,
      state: "CLOSED" as const,
      closesAt: "2026-08-10T00:00:00.000Z",
    };
    const closedDraftProjection = {
      ...draftProjection,
      call: {
        ...draftProjection.call,
        state: "CLOSED" as const,
        closesAt: closedProjection.closesAt,
      },
    };
    mocks.locateCall.mockReturnValue({ available: true, call: closedProjection });
    mocks.readCurrent.mockReturnValue({ found: true, draft: closedDraftProjection });

    const requestData = new FormData();
    requestData.set("email", "extended@example.test");
    const requested = await requestApplicantVerificationAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      requestData,
    );
    expect(requested.kind).toBe("success");
    expect(mocks.requestVerification).toHaveBeenCalledOnce();

    mocks.cookieValues.set(
      scopedCookieName("sympose_cfp_verification"),
      encodeCookie({
        version: 1,
        workspace: WORKSPACE,
        call: CALL_SLUG,
        verificationId: "verification_extended_1",
        token: "extended-verification-token-that-is-long-enough-1234",
      }),
    );
    const consumeData = new FormData();
    consumeData.set("fullName", "Extended Applicant");
    await expect(
      consumeApplicantVerificationAction(
        WORKSPACE,
        CALL_SLUG,
        IDLE_APPLICANT_ACTION_STATE,
        consumeData,
      ),
    ).rejects.toThrow("TEST_REDIRECT:/cfp/northstar/community-stage/draft");
    expect(mocks.consumeVerification).toHaveBeenCalledOnce();

    establishOwnedDraftCookieScope();
    const loaded = await loadApplicantDraftPage(WORKSPACE, CALL_SLUG);
    expect(loaded?.kind).toBe("draft");
    expect(mocks.readCurrent).toHaveBeenCalled();

    mocks.cookieValues.delete(scopedCookieName("sympose_cfp_submission"));
    await expect(
      createApplicantDraftAction(
        WORKSPACE,
        CALL_SLUG,
        IDLE_APPLICANT_ACTION_STATE,
        new FormData(),
      ),
    ).rejects.toThrow("TEST_REDIRECT:/cfp/northstar/community-stage/draft?saved=1");
    expect(mocks.createDraft).toHaveBeenCalledOnce();

    establishOwnedDraftCookieScope();
    const saveData = new FormData();
    saveData.set("answer:title", "Extended proposal");
    saveData.set("answer:format", "Talk");
    saveData.set("answer:privacy_ack", "true");
    await expect(
      saveApplicantDraftAction(
        WORKSPACE,
        CALL_SLUG,
        REVISION_ID,
        IDLE_APPLICANT_ACTION_STATE,
        saveData,
      ),
    ).rejects.toThrow("TEST_REDIRECT:/cfp/northstar/community-stage/draft?saved=1");

    const submitted = await submitApplicantDraftAction(
      WORKSPACE,
      CALL_SLUG,
      REVISION_ID,
      IDLE_APPLICANT_ACTION_STATE,
      new FormData(),
    );
    expect(submitted.kind).toBe("submitted");
    expect(mocks.saveDraft).toHaveBeenCalledTimes(2);
    expect(mocks.submitDraft).toHaveBeenCalledOnce();
  });

  it("uses a generic verification response without returning the raw generated token", async () => {
    const formData = new FormData();
    formData.set("email", "Applicant@Example.test");

    const state = await requestApplicantVerificationAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      formData,
    );

    expect(state).toEqual({
      kind: "success",
      code: "VERIFICATION_REQUESTED",
      message: "If this address can be verified for this call, a verification link is on its way.",
    });
    const input = mocks.requestVerification.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.email).toBe("applicant@example.test");
    expect(input.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(input).not.toHaveProperty("token");
    expect(JSON.stringify(state)).not.toContain(String(input.tokenHash));
    expect(JSON.stringify(state)).not.toContain("/access");

    expect(mocks.deliveryPort.prepareForRequest).toHaveBeenCalledWith({
      workspaceId: "workspace_northstar",
      workspaceSlug: WORKSPACE,
      callId: publicProjection.callId,
      callSlug: CALL_SLUG,
      email: "applicant@example.test",
    });
    const delivered = mocks.deliveryPort.deliver.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(delivered).toMatchObject({
      workspaceId: "workspace_northstar",
      workspaceSlug: WORKSPACE,
      callId: publicProjection.callId,
      callSlug: CALL_SLUG,
      email: "applicant@example.test",
      verificationId: "verification_requested_1",
      expiresAt: "2026-08-11T12:49:56.000Z",
    });
    expect(delivered.token).toMatch(/^[A-Za-z0-9_-]{32,512}$/);
    expect(createHash("sha256").update(String(delivered.token)).digest("hex")).toBe(
      input.tokenHash,
    );
    expect(JSON.stringify(state)).not.toContain(String(delivered.token));
  });

  it("fails closed behind the same generic response when delivery is unavailable", async () => {
    mocks.getDeliveryPort.mockReturnValueOnce(null);
    const formData = new FormData();
    formData.set("email", "applicant@example.test");

    const state = await requestApplicantVerificationAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      formData,
    );

    expect(state).toEqual({
      kind: "success",
      code: "VERIFICATION_REQUESTED",
      message: "If this address can be verified for this call, a verification link is on its way.",
    });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.requestVerification).not.toHaveBeenCalled();
    expect(mocks.deliveryPort.deliver).not.toHaveBeenCalled();
  });

  it("keeps the public response generic when issuance is not deliverable", async () => {
    mocks.requestVerification.mockReturnValueOnce({ accepted: false });
    const formData = new FormData();
    formData.set("email", "applicant@example.test");

    const state = await requestApplicantVerificationAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      formData,
    );

    expect(state).toEqual({
      kind: "success",
      code: "VERIFICATION_REQUESTED",
      message: "If this address can be verified for this call, a verification link is on its way.",
    });
    expect(mocks.deliveryPort.prepareForRequest).toHaveBeenCalledOnce();
    expect(mocks.deliveryPort.deliver).not.toHaveBeenCalled();
  });

  it("keeps delivery failure private and permits an immediate retry through the public action", async () => {
    mocks.requestVerification
      .mockReturnValueOnce({
        accepted: true,
        verificationId: "verification_failed_delivery",
        expiresAt: "2026-08-11T12:49:56.000Z",
      })
      .mockReturnValueOnce({
        accepted: true,
        verificationId: "verification_retry_delivery",
        expiresAt: "2026-08-11T12:50:01.000Z",
      });
    mocks.deliveryPort.deliver.mockRejectedValueOnce(
      new Error("sensitive-delivery-adapter-detail"),
    );
    const formData = new FormData();
    formData.set("email", "applicant@example.test");

    const failedDeliveryState = await requestApplicantVerificationAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      formData,
    );
    const retryState = await requestApplicantVerificationAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      formData,
    );

    expect(failedDeliveryState).toEqual(retryState);
    expect(failedDeliveryState.kind).toBe("success");
    expect(JSON.stringify(failedDeliveryState)).not.toContain(
      "sensitive-delivery-adapter-detail",
    );
    expect(mocks.requestVerification).toHaveBeenCalledTimes(2);
    expect(mocks.deliveryPort.deliver).toHaveBeenCalledTimes(2);
    const firstIssuance = mocks.requestVerification.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    const retryIssuance = mocks.requestVerification.mock.calls[1]?.[1] as Record<
      string,
      unknown
    >;
    expect(firstIssuance.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(retryIssuance.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(retryIssuance.tokenHash).not.toBe(firstIssuance.tokenHash);
    expect(mocks.deliveryPort.deliver.mock.calls[0]?.[0]).toMatchObject({
      verificationId: "verification_failed_delivery",
    });
    expect(mocks.deliveryPort.deliver.mock.calls[1]?.[0]).toMatchObject({
      verificationId: "verification_retry_delivery",
    });
  });

  it("retires the request connection when verification issuance reports a fatal boundary", async () => {
    const activeDb = mocks.activeDb();
    const fatal = new mocks.PortalFatalError();
    mocks.requestVerification.mockImplementationOnce(() => {
      throw fatal;
    });
    const formData = new FormData();
    formData.set("email", "applicant@example.test");

    await expect(
      requestApplicantVerificationAction(
        WORKSPACE,
        CALL_SLUG,
        IDLE_APPLICANT_ACTION_STATE,
        formData,
      ),
    ).rejects.toBe(fatal);

    expect(mocks.closeDb).toHaveBeenCalledOnce();
    expect(mocks.closeDb).toHaveBeenCalledWith(activeDb);
    expect(mocks.activeDb()).not.toBe(activeDb);
    expect(mocks.deliveryPort.deliver).not.toHaveBeenCalled();
  });

  it("consumes verification hashes server-side and stores only an httpOnly scoped session", async () => {
    const rawVerificationToken = "valid-verification-token-that-is-long-enough-12345";
    mocks.cookieValues.set(
      scopedCookieName("sympose_cfp_verification"),
      encodeCookie({
        version: 1,
        workspace: WORKSPACE,
        call: CALL_SLUG,
        verificationId: "verification_valid_1",
        token: rawVerificationToken,
      }),
    );
    const formData = new FormData();
    formData.set("fullName", "Alex Applicant");

    await expect(
      consumeApplicantVerificationAction(
        WORKSPACE,
        CALL_SLUG,
        IDLE_APPLICANT_ACTION_STATE,
        formData,
      ),
    ).rejects.toThrow("TEST_REDIRECT:/cfp/northstar/community-stage/draft");

    const input = mocks.consumeVerification.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.verificationTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(input.applicantSessionTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(input).not.toHaveProperty("verificationToken");
    expect(input).not.toHaveProperty("applicantSessionToken");
    expect(JSON.stringify(input)).not.toContain(rawVerificationToken);

    const sessionSet = mocks.cookieStore.set.mock.calls.find(
      ([name]) => name === scopedCookieName("sympose_cfp_applicant"),
    );
    expect(sessionSet?.[2]).toEqual(
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/cfp",
        expires: new Date("2026-08-25T00:00:00.000Z"),
      }),
    );
    expect(mocks.cookieValues.has("sympose_cfp_applicant")).toBe(false);
    const verificationClear = mocks.cookieStore.set.mock.calls.find(
      ([name, value]) =>
        name === scopedCookieName("sympose_cfp_verification") && value === "",
    );
    expect(verificationClear?.[2]).toEqual(
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/cfp", maxAge: 0 }),
    );
    const encoded = sessionSet?.[1];
    expect(typeof encoded).toBe("string");
    const payload = JSON.parse(Buffer.from(String(encoded), "base64url").toString("utf8")) as {
      workspace: string;
      call: string;
      token: string;
    };
    expect(payload.workspace).toBe(WORKSPACE);
    expect(payload.call).toBe(CALL_SLUG);
    expect(payload.token).toMatch(/^[A-Za-z0-9_-]{32,512}$/);
    expect(payload.token).not.toBe(rawVerificationToken);
  });

  it("returns one non-reflective error for an expired or invalid verification", async () => {
    const rawToken = "expired-verification-token-that-is-long-enough-1234";
    mocks.cookieValues.set(
      scopedCookieName("sympose_cfp_verification"),
      encodeCookie({
        version: 1,
        workspace: WORKSPACE,
        call: CALL_SLUG,
        verificationId: "verification_expired_1",
        token: rawToken,
      }),
    );
    mocks.consumeVerification.mockImplementation(() => {
      throw new mocks.PortalError("PORTAL_WRITE_FAILED");
    });
    const formData = new FormData();
    formData.set("fullName", "Alex Applicant");

    const state = await consumeApplicantVerificationAction(
      WORKSPACE,
      CALL_SLUG,
      IDLE_APPLICANT_ACTION_STATE,
      formData,
    );

    expect(state).toEqual({
      kind: "error",
      code: "VERIFICATION_LINK_INVALID",
      message: "This verification link cannot be used. Request a new one.",
    });
    expect(JSON.stringify(state)).not.toContain(rawToken);
    expect(JSON.stringify(state)).not.toContain("verification_expired_1");
    expect(mocks.cookieValues.get(scopedCookieName("sympose_cfp_verification"))).toBe("");
  });

  it("scopes raw-link set and clear cookies while redirecting to clean relative URLs", async () => {
    const rawToken = "verification-token-that-is-long-enough-1234567890";
    const request = new NextRequest(
      `https://sympose.test/cfp/${WORKSPACE}/${CALL_SLUG}/access?verification=verification_1&token=${rawToken}`,
    );

    const response = await consumeLink(request, {
      params: Promise.resolve({ workspace: WORKSPACE, callSlug: CALL_SLUG }),
    });

    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe(`/cfp/${WORKSPACE}/${CALL_SLUG}/verify`);
    expect(location).not.toContain(rawToken);
    expect(location).not.toContain("verification_1");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${scopedCookieName("sympose_cfp_verification")}=`);
    expect(setCookie).not.toContain("sympose_cfp_verification=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie.toLowerCase()).toContain("max-age=900");
    expect(setCookie).not.toContain(rawToken);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const otherCall = "second-stage";
    const invalidResponse = await consumeLink(
      new NextRequest(
        `https://sympose.test/cfp/${WORKSPACE}/${otherCall}/access?verification=verification_2&token=short`,
      ),
      { params: Promise.resolve({ workspace: WORKSPACE, callSlug: otherCall }) },
    );
    expect(invalidResponse.status).toBe(303);
    expect(invalidResponse.headers.get("location")).toBe(
      `/cfp/${WORKSPACE}/${otherCall}/verify?link=invalid`,
    );
    const clearedCookie = invalidResponse.headers.get("set-cookie") ?? "";
    expect(clearedCookie).toContain(
      `${scopedCookieName("sympose_cfp_verification", WORKSPACE, otherCall)}=`,
    );
    expect(clearedCookie).not.toContain(scopedCookieName("sympose_cfp_verification"));
    expect(clearedCookie.toLowerCase()).toContain("max-age=0");
    expect(clearedCookie).toContain("HttpOnly");
    expect(clearedCookie.toLowerCase()).toContain("samesite=lax");
  });
});

function neverReceipt(): never {
  throw new Error("expected a submitted receipt");
}
