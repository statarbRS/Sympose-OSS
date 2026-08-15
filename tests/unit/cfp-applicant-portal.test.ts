import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { SessionInfo } from "../../src/server/auth";
import { fingerprintOf } from "../../src/server/canonical";
import type { Db } from "../../src/server/db";
import { closeDb, openDb } from "../../src/server/db";
import {
  CfpApplicantAccessError,
  CfpApplicantAccessFatalError,
  consumeEmailVerification,
  grantCallExtension,
  issueEmailVerification,
} from "../../src/server/services/cfp/applicant-access";
import type { CfpApplicantPortalOptions } from "../../src/server/services/cfp/applicant-portal";
import {
  CfpApplicantPortalFatalError,
  CfpApplicantPortalError,
  consumeApplicantEmailVerification,
  createApplicantSubmissionDraft,
  createCfpApplicantPortal,
  issueApplicantEmailVerificationForDelivery,
  locateExternallyReachableCall,
  readApplicantOwnedCurrentRevision,
  requestApplicantEmailVerification,
  saveApplicantSubmissionDraft,
  submitApplicantSubmission,
} from "../../src/server/services/cfp/applicant-portal";
import {
  createCall,
  createFormDefinition,
  FormDocumentPersistenceError,
  readCall,
  readFormVersionDocument,
  readRuleVersion,
  readSubmissionRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import { normalizeFormDocument } from "../../src/server/services/cfp/form-types";
import { CfpSubmissionCommandFatalError } from "../../src/server/services/cfp/submissions";

const FIXTURE_AT = "2026-08-10T00:00:00.000Z";
const CALL_CLOSES_AT = "2028-12-31T23:59:59.000Z";
const EXTENSION_ENDS_AT = "2029-12-31T23:59:59.000Z";
const VALID_64_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

function digestFor(label: string): string {
  return createHash("sha256").update(`sympose-test-${label}`).digest("hex");
}

type TestSetup = {
  db: Db;
  workspaceId: string;
  workspaceSlug: string;
  callId: string;
  callSlug: string;
  formVersionId: string;
  applicant: {
    email: string;
    personId: string;
    sessionId: string;
    sessionTokenHash: string;
  };
  submissionId: string;
  revisionId: string;
};

function setupTestEnvironment(
  db: Db,
  options?: {
    workspaceSlug?: string;
    callSlug?: string;
    accessMode?: "PUBLIC" | "INVITED" | "PUBLIC_AND_INVITED";
    state?: "DRAFT" | "SCHEDULED" | "OPEN" | "PAUSED" | "CLOSED" | "ARCHIVED" | "CANCELLED";
  },
): TestSetup {
  const workspaceSlug = options?.workspaceSlug ?? "northstar";
  const callSlug = options?.callSlug ?? "talks-2026";
  const accessMode = options?.accessMode ?? "PUBLIC";
  const state = options?.state ?? "OPEN";

  const workspace = db
    .prepare("SELECT id FROM workspaces WHERE slug = ?")
    .get(workspaceSlug) as { id: string } | undefined;

  let workspaceId: string;
  if (!workspace) {
    workspaceId = `ws_${workspaceSlug}`;
    db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(
      workspaceId,
      workspaceSlug,
      `Workspace ${workspaceSlug}`,
      FIXTURE_AT,
    );
  } else {
    workspaceId = workspace.id;
  }

  const accountId = `acc_${workspaceSlug}`;
  const existingAccount = db.prepare("SELECT id FROM accounts WHERE id = ?").get(accountId);
  if (!existingAccount) {
    db.prepare(
      "INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(accountId, workspaceId, `admin@${workspaceSlug}.com`, "Admin", "organizer", FIXTURE_AT);
  }

  const organizer = { workspaceId, accountId };

  const eventId = `event_${workspaceSlug}`;
  const existingEvent = db.prepare("SELECT id FROM events WHERE id = ?").get(eventId);
  if (!existingEvent) {
    db.prepare(
      "INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(eventId, workspaceId, "Annual Conference", "UTC", FIXTURE_AT, CALL_CLOSES_AT, "planning", FIXTURE_AT);
  }

  const formDef = createFormDefinition(db, organizer, { name: `Form ${workspaceSlug} ${callSlug}` });
  const sealed = sealFormVersion(db, organizer, {
    formDefinitionId: formDef.id,
    fields: [
      {
        id: "title",
        type: "shortText",
        label: "Proposal Title",
        required: true,
        defaultVisibility: "visible",
      },
      {
        id: "abstract",
        type: "longText",
        label: "Abstract",
        required: true,
        defaultVisibility: "visible",
      },
      {
        id: "notes",
        type: "longText",
        label: "Reviewer Notes",
        required: false,
        defaultVisibility: "hidden",
      },
      {
        id: "privacy_ack",
        type: "consent",
        label: "I accept privacy policy",
        required: true,
        defaultVisibility: "visible",
      },
    ],
    rules: {
      schema: FORM_RULES_SCHEMA,
      rules: [
        {
          id: "r1",
          condition: {
            kind: "field",
            fieldId: "title",
            operator: "equals",
            value: "Show Notes",
          },
          actions: [{ type: "show", targetFieldId: "notes" }],
        },
      ],
    },
  });

  const createdCall = createCall(db, organizer, {
    eventId,
    name: "Call for Proposals 2026",
    slug: callSlug,
    formVersionId: sealed.id,
    policy: {
      disclosure: {
        privacy: "We store your data securely.",
        retention: "Retained for 1 year.",
        aiProcessing: "No AI processing.",
        communication: "Email communication only.",
        consent: "Voluntary consent.",
        publication: "Accepted talks will be published.",
      },
      choices: [
        { fieldId: "privacy_ack", statement: "I accept privacy policy", required: true },
      ],
    },
    accessMode,
    state,
    timezone: "UTC",
    opensAt: FIXTURE_AT,
    closesAt: CALL_CLOSES_AT,
  });

  const callId = createdCall.id;

  const applicantEmail = `applicant@${workspaceSlug}.com`;
  const tokenHash = digestFor(`verification_${workspaceSlug}_${callSlug}_${applicantEmail}`);
  const issued = issueEmailVerification(
    db,
    { workspaceId },
    { callId, email: applicantEmail, tokenHash },
  );

  const sessionTokenHash = digestFor(`session_${workspaceSlug}_${callSlug}_${applicantEmail}`);
  const session = consumeEmailVerification(
    db,
    { workspaceId },
    {
      callId,
      verificationId: issued.verificationId,
      verificationTokenHash: tokenHash,
      applicantSessionTokenHash: sessionTokenHash,
      fullName: "Jane Applicant",
    },
  );

  const createdDraft = createApplicantSubmissionDraft(db, {
    workspaceId,
    callId,
    sessionTokenHash,
  });

  const savedRevision = saveApplicantSubmissionDraft(db, {
    workspaceId,
    callId,
    sessionTokenHash,
    submissionId: createdDraft.submissionId,
    historicalAnswers: [
      { fieldId: "title", value: "My Great Talk" },
      { fieldId: "abstract", value: "This talk explains..." },
      { fieldId: "privacy_ack", value: true },
    ],
    expectedCurrentRevisionId: null,
  });

  return {
    db,
    workspaceId,
    workspaceSlug,
    callId,
    callSlug,
    formVersionId: sealed.id,
    applicant: {
      email: applicantEmail,
      personId: session.personId,
      sessionId: session.sessionId,
      sessionTokenHash,
    },
    submissionId: createdDraft.submissionId,
    revisionId: savedRevision.revisionId,
  };
}

function validSavedSeamEnvelope(
  db: Db,
  setup: Pick<TestSetup, "submissionId" | "revisionId">,
  revisionId = "rev_valid_seam_result",
): { readonly revisionId: string; readonly revision: any } {
  const row = db
    .prepare("SELECT revision_json FROM submission_revisions WHERE id = ?")
    .get(setup.revisionId) as { revision_json: string };
  return {
    revisionId,
    revision: JSON.parse(row.revision_json),
  };
}

function refingerprintRevisionWithFormIds(
  revision: any,
  formVersionId: string,
  ruleVersionId: string,
): any {
  const { fingerprint: _priorFingerprint, ...formContent } = revision.formDocument;
  const formDocument = normalizeFormDocument({
    ...formContent,
    formVersionId,
    ruleVersionId,
  });
  const content = {
    schema: revision.schema,
    submissionId: revision.submissionId,
    revisionNumber: revision.revisionNumber,
    formDocument,
    callPolicy: revision.callPolicy,
    consentReceipt: revision.consentReceipt,
    fingerprintAlgorithm: revision.fingerprintAlgorithm,
  };
  return { ...content, fingerprint: fingerprintOf(content) };
}

describe("W1-O3A-R1 — Applicant Portal Projection and Action Seam", () => {
  it("locates an externally reachable public call correctly", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const res = locateExternallyReachableCall(db, {
        workspaceSlug: setup.workspaceSlug,
        callSlug: setup.callSlug,
      });

      expect(res.available).toBe(true);
      if (res.available) {
        expect(res.call.callId).toBe(setup.callId);
        expect(res.call.name).toBe("Call for Proposals 2026");
        expect(res.call.slug).toBe(setup.callSlug);
        expect(res.call.accessMode).toBe("PUBLIC");
        expect(res.call.state).toBe("OPEN");
        expect(res.call.timezone).toBe("UTC");
        expect(res.call.fields.length).toBe(4);
        expect(res.call.choices.length).toBe(1);
        expect(Object.keys(res.call.fields[0]!).sort()).toEqual(
          ["defaultVisibility", "id", "label", "required", "type"].sort(),
        );

        const json = JSON.stringify(res.call);
        expect(json).not.toContain(setup.workspaceId);
        expect(json).not.toContain(setup.formVersionId);
        expect(json).not.toContain("policy_json");
      }
    } finally {
      closeDb(db);
    }
  });

  it("collapses invited/private calls to unavailable (Adversarial: invited/private call discovery)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const workspaceId = "ws_invited";
      db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(
        workspaceId,
        "ws-invited",
        "Invited Workspace",
        FIXTURE_AT,
      );
      const accountId = "acc_invited";
      db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        accountId, workspaceId, "admin@invited.com", "Admin", "organizer", FIXTURE_AT,
      );
      const organizer = { workspaceId, accountId };
      const eventId = "event_invited";
      db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        eventId, workspaceId, "Private Event", "UTC", FIXTURE_AT, CALL_CLOSES_AT, "planning", FIXTURE_AT,
      );
      const formDef = createFormDefinition(db, organizer, { name: "Private Form" });
      const sealed = sealFormVersion(db, organizer, {
        formDefinitionId: formDef.id,
        fields: [{ id: "t", type: "shortText", label: "T", required: true, defaultVisibility: "visible" }],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      createCall(db, organizer, {
        eventId,
        name: "Private Call",
        slug: "private-call",
        formVersionId: sealed.id,
        policy: {
          disclosure: { privacy: "p", retention: "r", aiProcessing: "a", communication: "c", consent: "co", publication: "pu" },
          choices: [],
        },
        accessMode: "INVITED",
        state: "OPEN",
        timezone: "UTC",
        opensAt: FIXTURE_AT,
        closesAt: CALL_CLOSES_AT,
      });

      const invitedRes = locateExternallyReachableCall(db, {
        workspaceSlug: "ws-invited",
        callSlug: "private-call",
      });
      expect(invitedRes.available).toBe(false);

      createCall(db, organizer, {
        eventId,
        name: "Draft Call",
        slug: "draft-call",
        formVersionId: sealed.id,
        policy: {
          disclosure: { privacy: "p", retention: "r", aiProcessing: "a", communication: "c", consent: "co", publication: "pu" },
          choices: [],
        },
        accessMode: "PUBLIC",
        state: "DRAFT",
        timezone: "UTC",
        opensAt: FIXTURE_AT,
        closesAt: CALL_CLOSES_AT,
      });

      const draftRes = locateExternallyReachableCall(db, {
        workspaceSlug: "ws-invited",
        callSlug: "draft-call",
      });
      expect(draftRes.available).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("handles Tenant A/B and slug aliasing cleanly (Adversarial: Tenant A/B)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setupA = setupTestEnvironment(db, { workspaceSlug: "tenant-a", callSlug: "cfp" });
      const setupB = setupTestEnvironment(db, { workspaceSlug: "tenant-b", callSlug: "cfp" });

      const resA = locateExternallyReachableCall(db, { workspaceSlug: "tenant-a", callSlug: "cfp" });
      const resB = locateExternallyReachableCall(db, { workspaceSlug: "tenant-b", callSlug: "cfp" });

      expect(resA.available).toBe(true);
      expect(resB.available).toBe(true);
      if (resA.available && resB.available) {
        expect(resA.call.callId).toBe(setupA.callId);
        expect(resB.call.callId).toBe(setupB.callId);
        expect(resA.call.callId).not.toBe(resB.call.callId);
      }

      const foreignRead = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setupA.workspaceId,
        callId: setupA.callId,
        sessionTokenHash: setupB.applicant.sessionTokenHash,
        submissionId: setupA.submissionId,
      });
      expect(foreignRead.found).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("requests verification preserving privacy (Adversarial: safe errors)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const tokenHash = digestFor("new_req_token");

      const res = requestApplicantEmailVerification(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        email: "newapplicant@northstar.com",
        tokenHash,
      });

      expect(res).toEqual({ success: true });

      const deliveryCandidate = issueApplicantEmailVerificationForDelivery(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        email: "delivered@northstar.com",
        tokenHash: digestFor("delivered_req_token"),
      });
      expect(deliveryCandidate).toEqual({
        accepted: true,
        verificationId: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(deliveryCandidate).not.toHaveProperty("email");
      expect(deliveryCandidate).not.toHaveProperty("tokenHash");
    } finally {
      closeDb(db);
    }
  });

  it("consumes verification and returns stripped session result without internal IDs", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const tokenHash = digestFor("consume_token_hash");
      const sessionHash = digestFor("session_token_hash");

      const issued = issueEmailVerification(
        db,
        { workspaceId: setup.workspaceId },
        { callId: setup.callId, email: "user2@northstar.com", tokenHash },
      );

      const res = consumeApplicantEmailVerification(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        verificationId: issued.verificationId,
        verificationTokenHash: tokenHash,
        applicantSessionTokenHash: sessionHash,
        fullName: "User Two",
      });

      expect(res.success).toBe(true);
      expect(res.expiresAt).toBeDefined();

      const raw = res as unknown as Record<string, unknown>;
      expect(raw.sessionId).toBeUndefined();
      expect(raw.workspaceId).toBeUndefined();
      expect(raw.callId).toBeUndefined();
      expect(raw.personId).toBeUndefined();

      const json = JSON.stringify(res);
      expect(json).not.toContain(setup.workspaceId);
      expect(json).not.toContain(setup.callId);
    } finally {
      closeDb(db);
    }
  });

  it("enforces required bounded fullName on email verification consumption", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const tokenHash = digestFor("consume_fn_token");
      const sessionHash = digestFor("session_fn_hash");

      const issued = issueEmailVerification(
        db,
        { workspaceId: setup.workspaceId },
        { callId: setup.callId, email: "fnuser@northstar.com", tokenHash },
      );

      // Missing fullName (casting for test)
      expect(() => {
        consumeApplicantEmailVerification(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          verificationId: issued.verificationId,
          verificationTokenHash: tokenHash,
          applicantSessionTokenHash: sessionHash,
        } as unknown as { workspaceId: string; callId: string; verificationId: string; verificationTokenHash: string; applicantSessionTokenHash: string; fullName: string });
      }).toThrow(CfpApplicantPortalError);

      // Empty / whitespace fullName
      expect(() => {
        consumeApplicantEmailVerification(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          verificationId: issued.verificationId,
          verificationTokenHash: tokenHash,
          applicantSessionTokenHash: sessionHash,
          fullName: "   ",
        });
      }).toThrow(CfpApplicantPortalError);
    } finally {
      closeDb(db);
    }
  });

  it("reads applicant-owned current revision with complete presentation state", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const res = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });

      expect(res.found).toBe(true);
      if (res.found) {
        expect(res.draft.submissionId).toBe(setup.submissionId);
        expect(res.draft.submissionState).toBe("DRAFT");
        expect(res.draft.currentRevisionId).toBe(setup.revisionId);
        expect(res.draft.fields.length).toBe(4);
        expect(res.draft.historicalAnswers.length).toBe(3);
        expect(res.draft.effectiveAnswers.length).toBe(3);

        expect(res.draft.presentationState.fieldStates.length).toBe(4);
        expect(res.draft.presentationState.hiddenFieldIds).toContain("notes");
        expect(res.draft.hasConsentReceipt).toBe(true);

        const json = JSON.stringify(res.draft);
        expect(json).not.toContain(setup.applicant.personId);
        expect(json).not.toContain(setup.applicant.sessionId);
        expect(json).not.toContain(setup.applicant.email);
        expect(json).not.toContain("policy_json");
        expect(json).not.toContain("revision_json");
      }
    } finally {
      closeDb(db);
    }
  });

  it("lets a re-verified session read the same Person's receipt-bearing revision", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const verificationTokenHash = digestFor("reverified_receipt_verification");
      const secondSessionTokenHash = digestFor("reverified_receipt_session");
      const issued = issueEmailVerification(
        db,
        { workspaceId: setup.workspaceId },
        {
          callId: setup.callId,
          email: setup.applicant.email,
          tokenHash: verificationTokenHash,
        },
      );
      const secondSession = consumeEmailVerification(
        db,
        { workspaceId: setup.workspaceId },
        {
          callId: setup.callId,
          verificationId: issued.verificationId,
          verificationTokenHash,
          applicantSessionTokenHash: secondSessionTokenHash,
          fullName: "Jane Applicant",
        },
      );
      const historicalRevision = readSubmissionRevision(
        db,
        setup.workspaceId,
        setup.revisionId,
      );

      expect(secondSession.personId).toBe(setup.applicant.personId);
      expect(secondSession.sessionId).not.toBe(setup.applicant.sessionId);
      expect(historicalRevision.consentReceipt?.applicantSessionId).toBe(
        setup.applicant.sessionId,
      );

      const result = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: secondSessionTokenHash,
        submissionId: setup.submissionId,
      });

      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.draft.currentRevisionId).toBe(setup.revisionId);
        expect(result.draft.hasConsentReceipt).toBe(true);
      }
    } finally {
      closeDb(db);
    }
  });

  it("evaluates rules dynamically in presentation state (Adversarial: hidden/skipped answer treatment)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const updated = saveApplicantSubmissionDraft(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
        historicalAnswers: [
          { fieldId: "title", value: "Show Notes" },
          { fieldId: "abstract", value: "This talk has notes." },
          { fieldId: "privacy_ack", value: true },
        ],
        expectedCurrentRevisionId: setup.revisionId,
      });

      const res = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });

      expect(res.found).toBe(true);
      if (res.found) {
        expect(res.draft.currentRevisionId).toBe(updated.revisionId);
        expect(res.draft.presentationState.hiddenFieldIds).not.toContain("notes");
      }
    } finally {
      closeDb(db);
    }
  });

  it("rejects unauthorized reads (Adversarial: wrong call and foreign submission)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setupA = setupTestEnvironment(db, { workspaceSlug: "ws-a", callSlug: "call-a" });
      const setupB = setupTestEnvironment(db, { workspaceSlug: "ws-b", callSlug: "call-b" });

      const wrongCallRead = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setupA.workspaceId,
        callId: setupA.callId,
        sessionTokenHash: setupA.applicant.sessionTokenHash,
        submissionId: setupB.submissionId,
      });
      expect(wrongCallRead.found).toBe(false);

      const foreignPersonRead = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setupA.workspaceId,
        callId: setupA.callId,
        sessionTokenHash: setupB.applicant.sessionTokenHash,
        submissionId: setupA.submissionId,
      });
      expect(foreignPersonRead.found).toBe(false);

      const nonExistentRead = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setupA.workspaceId,
        callId: setupA.callId,
        sessionTokenHash: setupA.applicant.sessionTokenHash,
        submissionId: "sub_non_existent",
      });
      expect(nonExistentRead.found).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("enforces session expiry and revocation (Adversarial: invalid/expired/revoked session)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      db.prepare(
        "UPDATE cfp_applicant_sessions SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ?",
      ).run(FIXTURE_AT, `acc_${setup.workspaceSlug}`, "Testing revocation", setup.applicant.sessionId);

      const revokedRead = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });
      expect(revokedRead.found).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("handles call extension past deadline (Adversarial: closed/paused/stale access)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const pastClose = "2026-08-10T00:00:00.000Z";
      db.prepare("UPDATE calls SET state = 'CLOSED', closes_at = ? WHERE id = ?").run(pastClose, setup.callId);

      const portal = createCfpApplicantPortal();

      const closedRead = portal.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });
      expect(closedRead.found).toBe(false);

      const adminSession: SessionInfo = {
        id: "sess_admin",
        tokenHash: "hash_admin",
        accountId: `acc_${setup.workspaceSlug}`,
        workspaceId: setup.workspaceId,
        expiresAt: EXTENSION_ENDS_AT,
        email: "admin@test.com",
        displayName: "Admin",
        role: "organizer",
        workspaceSlug: setup.workspaceSlug,
        workspaceName: "Test Workspace",
      };
      grantCallExtension(db, adminSession, {
        callId: setup.callId,
        personId: setup.applicant.personId,
        extendsTo: EXTENSION_ENDS_AT,
        reason: "VIP Extension",
        idempotencyKey: "ext_001",
      });

      const extendedRead = portal.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });
      expect(extendedRead.found).toBe(true);
    } finally {
      closeDb(db);
    }
  });

  it("handles stale revision check on save/submit (Adversarial: stale expected revision)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      expect(() => {
        saveApplicantSubmissionDraft(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
          submissionId: setup.submissionId,
          historicalAnswers: [],
          expectedCurrentRevisionId: "rev_stale_12345678901234567890123456789012",
        });
      }).toThrow(CfpApplicantPortalError);
    } finally {
      closeDb(db);
    }
  });

  it("validates token hash exact length 64 lowercase hex (Adversarial: token hash format)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const uppercaseHash = VALID_64_HEX.toUpperCase();
      expect(() => {
        readApplicantOwnedCurrentRevision(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: uppercaseHash,
          submissionId: setup.submissionId,
        });
      }).toThrow(CfpApplicantPortalError);

      expect(() => {
        readApplicantOwnedCurrentRevision(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: "abc123",
          submissionId: setup.submissionId,
        });
      }).toThrow(CfpApplicantPortalError);
    } finally {
      closeDb(db);
    }
  });

  it("detects pointer drift between initial read and recheck (Adversarial: pointer drift)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const customPortal = createCfpApplicantPortal({
        readSubmissionRevision: (dbConn, wsId, revId) => {
          dbConn.prepare("UPDATE submissions SET current_revision_id = 'rev_drifted_999' WHERE id = ?").run(setup.submissionId);
          const realRead = dbConn.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(revId) as { revision_json: string };
          return JSON.parse(realRead.revision_json);
        },
      });

      const res = customPortal.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });

      expect(res.found).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("rejects divergent evaluator output from stored effective answers (Adversarial: divergent evaluator)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const customPortal = createCfpApplicantPortal({
        readSubmissionRevision: (dbConn, wsId, revId) => {
          const row = dbConn.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(revId) as { revision_json: string };
          const parsed = JSON.parse(row.revision_json);
          parsed.formDocument.effectiveAnswers = [{ fieldId: "title", value: "TAMPERED_ANSWER" }];
          return parsed;
        },
      });

      const res = customPortal.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });

      expect(res.found).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("validates malformed database storage values safely (Adversarial: malformed storage)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      db.prepare("UPDATE calls SET timezone = 'CORRUPTED/TIMEZONE' WHERE id = ?").run(setup.callId);

      const res = locateExternallyReachableCall(db, {
        workspaceSlug: setup.workspaceSlug,
        callSlug: setup.callSlug,
      });
      expect(res.available).toBe(false);

      const readRes = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });
      expect(readRes.found).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("tolerates hostile proxies, extra keys, and getter traps in inputs and options (Adversarial: hostile proxies)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const throwingInput = new Proxy({
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      }, {
        get(target, prop) {
          if (prop === "extraProp") throw new Error("Hostile Getter Trap");
          return Reflect.get(target, prop);
        },
        ownKeys() {
          return ["workspaceId", "callId", "sessionTokenHash", "submissionId", "extraProp"];
        },
        getOwnPropertyDescriptor(target, prop) {
          return { enumerable: true, configurable: true, value: (target as Record<string, unknown>)[prop as string] };
        },
      });

      expect(() => {
        readApplicantOwnedCurrentRevision(db, throwingInput as unknown as { workspaceId: string; callId: string; sessionTokenHash: string; submissionId: string });
      }).toThrow(CfpApplicantPortalError);

      const extraKeysInput = {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
        unauthorizedKey: "malicious_payload",
      };

      expect(() => {
        readApplicantOwnedCurrentRevision(db, extraKeysInput);
      }).toThrow(CfpApplicantPortalError);

      expect(() => {
        createCfpApplicantPortal(new Proxy({} as Record<string, unknown>, {
          get() {
            throw new Error("Hostile Options Trap");
          },
          ownKeys() {
            return ["readCall"];
          },
          getOwnPropertyDescriptor() {
            return { enumerable: true, configurable: true, value: undefined };
          },
        }) as unknown as CfpApplicantPortalOptions);
      }).toThrow(CfpApplicantPortalError);
    } finally {
      closeDb(db);
    }
  });

  it("tolerates forged/subclassed errors thrown by dependencies without reflecting raw error messages (Adversarial: forged errors)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const forgedError = new Proxy(new Error("SELECT * FROM secret_table WHERE 1=1"), {
        get(target, prop) {
          if (prop === "code") return "UNKNOWN_FORGED_CODE";
          if (prop === "message") throw new Error("Nested Trap Message");
          return Reflect.get(target, prop);
        },
      });

      const customPortal = createCfpApplicantPortal({
        issueEmailVerification: () => {
          throw forgedError;
        },
      });

      try {
        customPortal.requestApplicantEmailVerification(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          email: "test@northstar.com",
          tokenHash: setup.applicant.sessionTokenHash,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantPortalError);
        const portalErr = err as CfpApplicantPortalError;
        expect(portalErr.code).toBe("PORTAL_WRITE_FAILED");
        expect(portalErr.message).not.toContain("SELECT");
        expect(portalErr.message).not.toContain("Trap");
      }
    } finally {
      closeDb(db);
    }
  });

  it("converts a genuine applicant-access transaction fatal into a portal fatal stop", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const accessFatal = new CfpApplicantAccessFatalError();
      const fatalPortal = createCfpApplicantPortal({
        issueEmailVerification: () => {
          throw accessFatal;
        },
      });

      try {
        fatalPortal.issueApplicantEmailVerificationForDelivery(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          email: "fatal-boundary@example.test",
          tokenHash: "f".repeat(64),
        });
        expect.fail("expected a portal fatal stop");
      } catch (error) {
        expect(error).toBeInstanceOf(CfpApplicantPortalFatalError);
        expect(error).not.toBe(accessFatal);
      }
    } finally {
      closeDb(db);
    }
  });

  it("deep freezes and detaches projected nested objects to prevent caller mutation (Adversarial: deep freeze)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const res = locateExternallyReachableCall(db, {
        workspaceSlug: setup.workspaceSlug,
        callSlug: setup.callSlug,
      });

      expect(res.available).toBe(true);
      if (res.available) {
        expect(() => {
          (res.call.fields[0] as unknown as { label: string }).label = "TAMPERED";
        }).toThrow();

        expect(() => {
          (res.call.choices as unknown as Array<unknown>).push({ fieldId: "fake" });
        }).toThrow();
      }

      const draftRes = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });

      expect(draftRes.found).toBe(true);
      if (draftRes.found) {
        expect(() => {
          (draftRes.draft.presentationState.hiddenFieldIds as unknown as Array<string>).push("hacked");
        }).toThrow();
      }
    } finally {
      closeDb(db);
    }
  });

  it("proves denied reads have zero side-effects (Adversarial: denied-read no-side-effect proof)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const beforeRevisions = db.prepare("SELECT COUNT(*) AS c FROM submission_revisions").get() as { c: number };
      const beforeSubmissions = db.prepare("SELECT COUNT(*) AS c FROM submissions").get() as { c: number };

      readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: VALID_64_HEX,
        submissionId: setup.submissionId,
      });

      const afterRevisions = db.prepare("SELECT COUNT(*) AS c FROM submission_revisions").get() as { c: number };
      const afterSubmissions = db.prepare("SELECT COUNT(*) AS c FROM submissions").get() as { c: number };

      expect(afterRevisions.c).toBe(beforeRevisions.c);
      expect(afterSubmissions.c).toBe(beforeSubmissions.c);
    } finally {
      closeDb(db);
    }
  });

  it("executes submit submission wrapper successfully returning clean portal result", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const submitted = submitApplicantSubmission(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
        historicalAnswers: [
          { fieldId: "title", value: "Final Title" },
          { fieldId: "abstract", value: "Final Abstract" },
          { fieldId: "privacy_ack", value: true },
        ],
        expectedCurrentRevisionId: setup.revisionId,
      });

      expect(submitted.submissionId).toBe(setup.submissionId);
      expect(submitted.revisionId).toBeDefined();
      expect(submitted.submittedAt).toBeDefined();

      const raw = submitted as unknown as Record<string, unknown>;
      expect(raw.workspaceId).toBeUndefined();
      expect(raw.ownerPersonId).toBeUndefined();
      expect(raw.personId).toBeUndefined();

      const subRow = db.prepare("SELECT state FROM submissions WHERE id = ?").get(setup.submissionId) as { state: string };
      expect(subRow.state).toBe("SUBMITTED");
    } finally {
      closeDb(db);
    }
  });

  it("proves saveApplicantSubmissionDraft does not perform post-command fallible projection work (Audit 2 Item 1)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const customPortal = createCfpApplicantPortal({
        readRuleVersion: () => {
          throw new Error("Post-command readRuleVersion failure");
        },
      });

      const res = customPortal.saveApplicantSubmissionDraft(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
        historicalAnswers: [
          { fieldId: "title", value: "New Title" },
          { fieldId: "abstract", value: "New Abstract" },
          { fieldId: "privacy_ack", value: true },
        ],
        expectedCurrentRevisionId: setup.revisionId,
      });

      expect(res.submissionId).toBe(setup.submissionId);
      expect(res.revisionId).toBeDefined();
      expect(res.hasConsentReceipt).toBe(true);

      const raw = res as unknown as Record<string, unknown>;
      expect(raw.presentationState).toBeUndefined();
    } finally {
      closeDb(db);
    }
  });

  it("binds command seam results strictly to request parameters (Audit 2 Item 2)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const badCreatePortal = createCfpApplicantPortal({
        createSubmissionDraft: () => ({
          id: "sub_mismatched",
          workspaceId: "ws_different",
          callId: setup.callId,
          eventId: "event_1",
          ownerPersonId: "person_1",
          pinnedFormVersionId: "fv_1",
          pinnedRuleVersionId: "rv_1",
        }),
      });

      expect(() => {
        badCreatePortal.createApplicantSubmissionDraft(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
        });
      }).toThrow(CfpApplicantPortalError);

      const badSavePortal = createCfpApplicantPortal({
        saveSubmissionDraft: () => ({
          revisionId: "rev_new_999",
          revision: {
            id: "rev_new_999",
            submissionId: "sub_mismatched_999",
            consentReceipt: null,
            formDocument: {
              formVersionId: "fv_1",
              ruleVersionId: "rv_1",
              fields: [],
              historicalAnswers: [],
              effectiveAnswers: [],
            },
          } as any,
        }),
      });

      expect(() => {
        badSavePortal.saveApplicantSubmissionDraft(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
          submissionId: setup.submissionId,
          historicalAnswers: [],
          expectedCurrentRevisionId: setup.revisionId,
        });
      }).toThrow(CfpApplicantPortalError);

      const badSubmitPortal = createCfpApplicantPortal({
        submitSubmission: () => ({
          submissionId: "sub_mismatched_888",
          revisionId: "rev_sub_888",
          submittedAt: FIXTURE_AT,
        }),
      });

      expect(() => {
        badSubmitPortal.submitApplicantSubmission(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
          submissionId: setup.submissionId,
          historicalAnswers: [],
          expectedCurrentRevisionId: setup.revisionId,
        });
      }).toThrow(CfpApplicantPortalError);
    } finally {
      closeDb(db);
    }
  });

  it("reports invalid post-command envelopes as durable non-retryable indeterminate outcomes", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      db.exec("CREATE TEMP TABLE portal_durable_markers (kind TEXT PRIMARY KEY)");
      const markDurable = (kind: string): void => {
        db.prepare("INSERT INTO portal_durable_markers (kind) VALUES (?)").run(kind);
      };
      const portal = createCfpApplicantPortal({
        consumeEmailVerification: (() => {
          markDurable("consume");
          return { success: "malformed" };
        }) as never,
        createSubmissionDraft: (() => {
          markDurable("create");
          return { id: "incomplete" };
        }) as never,
        saveSubmissionDraft: (() => {
          markDurable("save");
          return { revisionId: "incomplete" };
        }) as never,
        submitSubmission: (() => {
          markDurable("submit");
          return { submittedAt: "incomplete" };
        }) as never,
      });
      const identity = {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
      };
      const operations = [
        [
          "consume",
          () =>
            portal.consumeApplicantEmailVerification(db, {
              workspaceId: setup.workspaceId,
              callId: setup.callId,
              verificationId: "verification_indeterminate",
              verificationTokenHash: "a".repeat(64),
              applicantSessionTokenHash: "b".repeat(64),
              fullName: "Indeterminate Applicant",
            }),
        ],
        ["create", () => portal.createApplicantSubmissionDraft(db, identity)],
        [
          "save",
          () =>
            portal.saveApplicantSubmissionDraft(db, {
              ...identity,
              submissionId: setup.submissionId,
              historicalAnswers: [],
              expectedCurrentRevisionId: setup.revisionId,
            }),
        ],
        [
          "submit",
          () =>
            portal.submitApplicantSubmission(db, {
              ...identity,
              submissionId: setup.submissionId,
              historicalAnswers: [],
              expectedCurrentRevisionId: setup.revisionId,
            }),
        ],
      ] as const;

      for (const [kind, invoke] of operations) {
        expect(invoke).toThrowError(
          expect.objectContaining({
            code: "PORTAL_WRITE_INDETERMINATE",
            message:
              "The CFP applicant portal command result is indeterminate; do not retry automatically.",
          }),
        );
        expect(
          db.prepare("SELECT kind FROM portal_durable_markers WHERE kind = ?").get(kind),
        ).toEqual({ kind });
      }
    } finally {
      closeDb(db);
    }
  });

  it("rejects proxy historicalAnswers before O2C and delegates only bounded detached JSON (Audit 2 Item 6)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      let getCount = 0;
      const targetObj = { fieldId: "title", value: "Proxy Answer" };
      const answerProxy = new Proxy(targetObj, {
        get(t, prop) {
          if (prop === "value") {
            getCount++;
          }
          return Reflect.get(t, prop);
        },
      });

      let seamObservedAnswers: unknown = null;
      let seamCalls = 0;

      const portalWithInspector = createCfpApplicantPortal({
        saveSubmissionDraft: (d, input) => {
          seamCalls += 1;
          seamObservedAnswers = input.historicalAnswers;
          return validSavedSeamEnvelope(db, setup, "rev_inspected");
        },
      });

      expect(() =>
        portalWithInspector.saveApplicantSubmissionDraft(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
          submissionId: setup.submissionId,
          historicalAnswers: [answerProxy],
          expectedCurrentRevisionId: setup.revisionId,
        }),
      ).toThrow(CfpApplicantPortalError);
      expect(seamCalls).toBe(0);
      expect(getCount).toBe(0);

      portalWithInspector.saveApplicantSubmissionDraft(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
        historicalAnswers: [{ fieldId: "title", value: "Detached answer" }],
        expectedCurrentRevisionId: setup.revisionId,
      });
      expect(seamCalls).toBe(1);
      expect(Object.isFrozen(seamObservedAnswers)).toBe(true);
      expect(Object.isFrozen((seamObservedAnswers as readonly object[])[0])).toBe(true);
    } finally {
      closeDb(db);
    }
  });

  it("collapses hostile proxy traps in deepFreezeAndDetach without leaking trap error messages (Audit 2 Item 7)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const hostileSeamPortal = createCfpApplicantPortal({
        readCall: () => {
          const raw = {
            id: setup.callId,
            workspaceId: setup.workspaceId,
            accessMode: "PUBLIC",
            state: "OPEN",
            timezone: "UTC",
            opensAt: FIXTURE_AT,
            closesAt: CALL_CLOSES_AT,
            policy: { disclosure: {}, choices: [] },
            formVersionId: setup.formVersionId,
          };
          return new Proxy(raw, {
            get(target, prop) {
              if (prop === "timezone") throw new Error("Hostile Read Trap Error");
              return Reflect.get(target, prop);
            },
            ownKeys() {
              throw new Error("Hostile ownKeys Trap Error");
            },
          }) as any;
        },
      });

      try {
        const res = hostileSeamPortal.readApplicantOwnedCurrentRevision(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
          submissionId: setup.submissionId,
        });
        expect(res.found).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantPortalError);
        const pErr = err as CfpApplicantPortalError;
        expect(pErr.message).not.toContain("Hostile");
      }
    } finally {
      closeDb(db);
    }
  });

  it("uses an independent release path and emits a fatal stop when closure remains unproven", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const origExec = db.exec.bind(db);
      const origPrepare = db.prepare.bind(db);
      db.exec = (sql: string) => {
        if (sql.includes("RELEASE SAVEPOINT") && sql.includes("cfp_read_applicant_draft")) {
          throw new Error("Savepoint RELEASE simulated failure");
        }
        return origExec(sql);
      };

      expect(readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      }).found).toBe(true);

      db.prepare = ((sql: string) => {
        if (sql.includes("RELEASE SAVEPOINT") && sql.includes("cfp_read_applicant_draft")) {
          throw new Error("Prepared RELEASE simulated failure");
        }
        return origPrepare(sql);
      }) as typeof db.prepare;

      expect(() =>
        readApplicantOwnedCurrentRevision(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
          submissionId: setup.submissionId,
        }),
      ).toThrow(CfpApplicantPortalFatalError);
      expect(db.isTransaction).toBe(true);
    } finally {
      closeDb(db);
    }
  });

  it("preserves a caller-owned same-prefix savepoint and its transaction", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      db.exec("CREATE TEMP TABLE portal_caller_savepoint_probe (value TEXT PRIMARY KEY)");
      db.exec('SAVEPOINT "cfp_locate_call_1"');
      db.prepare("INSERT INTO portal_caller_savepoint_probe (value) VALUES (?)").run(
        "caller-owned-marker",
      );

      expect(
        locateExternallyReachableCall(db, {
          workspaceSlug: setup.workspaceSlug,
          callSlug: setup.callSlug,
        }).available,
      ).toBe(true);
      expect(db.isTransaction).toBe(true);
      expect(
        db
          .prepare("SELECT value FROM portal_caller_savepoint_probe WHERE value = ?")
          .get("caller-owned-marker"),
      ).toEqual({ value: "caller-owned-marker" });

      db.exec('ROLLBACK TO SAVEPOINT "cfp_locate_call_1"');
      db.exec('RELEASE SAVEPOINT "cfp_locate_call_1"');
      expect(db.isTransaction).toBe(false);
      expect(
        db
          .prepare("SELECT value FROM portal_caller_savepoint_probe WHERE value = ?")
          .get("caller-owned-marker"),
      ).toBeUndefined();
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      closeDb(db);
    }
  });

  it("collapses hostile proxies with throwing getPrototypeOf traps in deepFreezeAndDetach without raw leakage (Audit 3 Item 1)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const hostileProtoProxy = new Proxy({}, {
        getPrototypeOf() {
          throw new Error("Hostile getPrototypeOf Trap Error");
        },
      });

      expect(() => {
        saveApplicantSubmissionDraft(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
          submissionId: setup.submissionId,
          historicalAnswers: [hostileProtoProxy],
          expectedCurrentRevisionId: setup.revisionId,
        });
      }).toThrow(CfpApplicantPortalError);

      try {
        saveApplicantSubmissionDraft(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
          submissionId: setup.submissionId,
          historicalAnswers: [hostileProtoProxy],
          expectedCurrentRevisionId: setup.revisionId,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(CfpApplicantPortalError);
        const pErr = err as CfpApplicantPortalError;
        expect(pErr.code).toBe("PORTAL_INPUT_INVALID");
        expect(pErr.message).not.toContain("Hostile");
      }
    } finally {
      closeDb(db);
    }
  });

  it("handles thrown hostile proxies in locate and read paths without raw classification escape (Audit 3 Item 2)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const hostileThrownProxy = new Proxy(new Error("Underlying error"), {
        getPrototypeOf() {
          throw new Error("Hostile Exception Classification Trap");
        },
      });

      const hostileLocatePortal = createCfpApplicantPortal({
        readCall: () => {
          throw hostileThrownProxy;
        },
      });

      const locateRes = hostileLocatePortal.locateExternallyReachableCall(db, {
        workspaceSlug: setup.workspaceSlug,
        callSlug: setup.callSlug,
      });
      expect(locateRes.available).toBe(false);

      const hostileReadPortal = createCfpApplicantPortal({
        resolveApplicantSession: () => {
          throw hostileThrownProxy;
        },
      });

      const readRes = hostileReadPortal.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });
      expect(readRes.found).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("operates without ambient Math.random dependency during savepoint reads (Audit 3 Item 3)", () => {
    const db = openDb({ path: ":memory:" });
    const originalRandom = Math.random;
    try {
      Math.random = () => {
        throw new Error("Monkey-patched Math.random failure");
      };

      const setup = setupTestEnvironment(db);

      const res = locateExternallyReachableCall(db, {
        workspaceSlug: setup.workspaceSlug,
        callSlug: setup.callSlug,
      });
      expect(res.available).toBe(true);

      const readRes = readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      });
      expect(readRes.found).toBe(true);
    } finally {
      Math.random = originalRandom;
      closeDb(db);
    }
  });

  it("validates return envelope shape of saveSubmissionDraft seam (Audit 3 Item 4)", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);

      const testEnvelope = (seamReturn: unknown) => {
        const portal = createCfpApplicantPortal({
          saveSubmissionDraft: () => seamReturn as any,
        });
        return portal.saveApplicantSubmissionDraft(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
          submissionId: setup.submissionId,
          historicalAnswers: [],
          expectedCurrentRevisionId: setup.revisionId,
        });
      };

      const baseValid = validSavedSeamEnvelope(db, setup);
      const expectIndeterminate = (envelope: unknown) => {
        expect(() => testEnvelope(envelope)).toThrowError(
          expect.objectContaining({ code: "PORTAL_WRITE_INDETERMINATE" }),
        );
      };

      // Wrong or missing schema/algorithm.
      const missingSchema = JSON.parse(JSON.stringify(baseValid));
      delete missingSchema.revision.schema;
      expectIndeterminate(missingSchema);
      expectIndeterminate({ ...baseValid, revision: { ...baseValid.revision, schema: "cfp-submission-revision/v2" } });
      expectIndeterminate({ ...baseValid, revision: { ...baseValid.revision, fingerprintAlgorithm: "sha256" } });

      // Fingerprint must be exact lowercase SHA-256 shape.
      expectIndeterminate({ ...baseValid, revision: { ...baseValid.revision, fingerprint: "" } });
      expectIndeterminate({ ...baseValid, revision: { ...baseValid.revision, fingerprint: "A".repeat(64) } });
      expectIndeterminate({ ...baseValid, revision: { ...baseValid.revision, fingerprint: "g".repeat(64) } });

      // Invalid revisionNumber (0, negative, float, non-number)
      expectIndeterminate({ ...baseValid, revision: { ...baseValid.revision, revisionNumber: 0 } });
      expectIndeterminate({ ...baseValid, revision: { ...baseValid.revision, revisionNumber: -1 } });
      expectIndeterminate({ ...baseValid, revision: { ...baseValid.revision, revisionNumber: 1.5 } });

      // Nested artifacts and receipts must be complete and fingerprint-bound.
      expectIndeterminate({ ...baseValid, revision: { ...baseValid.revision, consentReceipt: ["invalid"] } });
      expectIndeterminate({
        ...baseValid,
        revision: {
          ...baseValid.revision,
          formDocument: { ...baseValid.revision.formDocument, organizerSecret: "account_private" },
        },
      });

      const withReceipt = testEnvelope(baseValid);
      expect(withReceipt.hasConsentReceipt).toBe(true);
    } finally {
      closeDb(db);
    }
  });

  it("maps mutated portal errors and accepted-error subclasses to fresh canonical failures", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const mutated = new CfpApplicantPortalError("SESSION_INVALID") as CfpApplicantPortalError & {
        message: string;
      };
      mutated.message = "secret SQL payload sub_private";
      const mutatedPortal = createCfpApplicantPortal({
        issueEmailVerification: () => {
          throw mutated;
        },
      });

      try {
        mutatedPortal.requestApplicantEmailVerification(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          email: "applicant@example.test",
          tokenHash: setup.applicant.sessionTokenHash,
        });
        expect.fail("expected a stable portal error");
      } catch (error) {
        expect(error).toBeInstanceOf(CfpApplicantPortalError);
        expect(error).not.toBe(mutated);
        expect((error as CfpApplicantPortalError).code).toBe("SESSION_INVALID");
        expect((error as Error).message).not.toContain("secret");
      }

      class ForgedAccessSubclass extends CfpApplicantAccessError {}
      const subclassPortal = createCfpApplicantPortal({
        issueEmailVerification: () => {
          throw new ForgedAccessSubclass("SESSION_INVALID");
        },
      });
      expect(() =>
        subclassPortal.requestApplicantEmailVerification(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          email: "applicant@example.test",
          tokenHash: setup.applicant.sessionTokenHash,
        }),
      ).toThrowError(expect.objectContaining({ code: "PORTAL_WRITE_FAILED" }));
    } finally {
      closeDb(db);
    }
  });

  it("does not let a hostile portal-error code getter escape locator classification", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const hostile = new Proxy(new CfpApplicantPortalError("PORTAL_READ_FAILED"), {
        get(target, property, receiver) {
          if (property === "code") throw new Error("RAW_CODE_TRAP");
          return Reflect.get(target, property, receiver);
        },
      });
      const portal = createCfpApplicantPortal({
        readCall: () => {
          throw hostile;
        },
      });
      expect(
        portal.locateExternallyReachableCall(db, {
          workspaceSlug: setup.workspaceSlug,
          callSlug: setup.callSlug,
        }),
      ).toEqual({ available: false });
    } finally {
      closeDb(db);
    }
  });

  it("rejects accessor result envelopes without returning unchecked second reads", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      let reads = 0;
      const portal = createCfpApplicantPortal({
        createSubmissionDraft: () => ({
          get id() {
            reads += 1;
            return reads === 1 ? "sub_checked" : "sub_unchecked";
          },
          workspaceId: setup.workspaceId,
          callId: setup.callId,
        }) as never,
      });
      expect(() =>
        portal.createApplicantSubmissionDraft(db, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
        }),
      ).toThrowError(expect.objectContaining({ code: "PORTAL_WRITE_INDETERMINATE" }));
      expect(reads).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("enforces cycle, depth, scalar, and value bounds before save or submit delegation", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      let saveCalls = 0;
      let submitCalls = 0;
      const portal = createCfpApplicantPortal({
        saveSubmissionDraft: (() => {
          saveCalls += 1;
          throw new Error("must not delegate");
        }) as never,
        submitSubmission: (() => {
          submitCalls += 1;
          throw new Error("must not delegate");
        }) as never,
      });
      const cycle: unknown[] = [];
      cycle.push(cycle);
      let tooDeep: unknown = "leaf";
      for (let index = 0; index < 34; index += 1) tooDeep = [tooDeep];
      const invalidValues = [cycle, tooDeep, "x".repeat(65 * 1024), () => "not JSON"];

      for (const historicalAnswers of invalidValues) {
        expect(() =>
          portal.saveApplicantSubmissionDraft(db, {
            workspaceId: setup.workspaceId,
            callId: setup.callId,
            sessionTokenHash: setup.applicant.sessionTokenHash,
            submissionId: setup.submissionId,
            historicalAnswers,
            expectedCurrentRevisionId: setup.revisionId,
          }),
        ).toThrowError(expect.objectContaining({ code: "PORTAL_INPUT_INVALID" }));
        expect(() =>
          portal.submitApplicantSubmission(db, {
            workspaceId: setup.workspaceId,
            callId: setup.callId,
            sessionTokenHash: setup.applicant.sessionTokenHash,
            submissionId: setup.submissionId,
            historicalAnswers,
            expectedCurrentRevisionId: setup.revisionId,
          }),
        ).toThrowError(expect.objectContaining({ code: "PORTAL_INPUT_INVALID" }));
      }
      expect(saveCalls).toBe(0);
      expect(submitCalls).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("keeps verification issuance non-enumerating and binds consumed session scope", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const denialPortal = createCfpApplicantPortal({
        issueEmailVerification: () => {
          throw new CfpApplicantAccessError("VERIFICATION_REQUEST_REJECTED");
        },
      });
      expect(denialPortal.requestApplicantEmailVerification(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        email: "known@example.test",
        tokenHash: "b".repeat(64),
      })).toEqual({ success: true });
      expect(denialPortal.issueApplicantEmailVerificationForDelivery(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        email: "known@example.test",
        tokenHash: "c".repeat(64),
      })).toEqual({ accepted: false });

      const mismatchedConsume = createCfpApplicantPortal({
        consumeEmailVerification: () => ({
          sessionId: "session_foreign",
          workspaceId: "workspace_foreign",
          callId: "call_foreign",
          personId: "person_foreign",
          expiresAt: "2030-01-01T00:00:00.000Z",
          replayed: false,
        }),
      });
      expect(() => mismatchedConsume.consumeApplicantEmailVerification(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        verificationId: "verification_1",
        verificationTokenHash: "c".repeat(64),
        applicantSessionTokenHash: "d".repeat(64),
        fullName: "Applicant",
      })).toThrowError(expect.objectContaining({ code: "PORTAL_WRITE_INDETERMINATE" }));

      const extraConsumedField = createCfpApplicantPortal({
        consumeEmailVerification: () => ({
          sessionId: "session_valid",
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          personId: "person_valid",
          expiresAt: "2030-01-01T00:00:00.000Z",
          replayed: false,
          organizerSecret: "account_private",
        }) as never,
      });
      expect(() => extraConsumedField.consumeApplicantEmailVerification(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        verificationId: "verification_2",
        verificationTokenHash: "e".repeat(64),
        applicantSessionTokenHash: "f".repeat(64),
        fullName: "Applicant",
      })).toThrowError(expect.objectContaining({ code: "PORTAL_WRITE_INDETERMINATE" }));
    } finally {
      closeDb(db);
    }
  });

  it("rejects mismatched session, access-grant, form, rule, and policy dependency mirrors", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      let accessCalls = 0;
      const wrongSession = createCfpApplicantPortal({
        resolveApplicantSession: () => ({
          context: { workspaceId: "workspace_foreign", sessionId: "session_foreign" },
          personId: setup.applicant.personId,
          callId: "call_foreign",
          expiresAt: "2030-01-01T00:00:00.000Z",
        }),
        assertApplicantAccess: (() => {
          accessCalls += 1;
          return { allowed: true, late: false, extensionId: null };
        }) as never,
      });
      expect(wrongSession.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      })).toEqual({ found: false });
      expect(accessCalls).toBe(0);

      const deniedGrant = createCfpApplicantPortal({
        assertApplicantAccess: (() => ({ allowed: false, late: false, extensionId: null })) as never,
      });
      expect(deniedGrant.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      })).toEqual({ found: false });

      const wrongForm = createCfpApplicantPortal({
        readFormVersionDocument: (database, workspaceId, formVersionId) => ({
          ...readFormVersionDocument(database, workspaceId, formVersionId),
          formVersionId: "form_foreign",
        }),
      });
      expect(wrongForm.locateExternallyReachableCall(db, {
        workspaceSlug: setup.workspaceSlug,
        callSlug: setup.callSlug,
      })).toEqual({ available: false });

      const organizerOnlyForm = createCfpApplicantPortal({
        readFormVersionDocument: (database, workspaceId, formVersionId) => {
          const form = readFormVersionDocument(database, workspaceId, formVersionId);
          return {
            ...form,
            fields: form.fields.map((field, index) =>
              index === 0 ? { ...field, organizerSecret: "account_private" } : field,
            ),
          } as never;
        },
      });
      expect(organizerOnlyForm.locateExternallyReachableCall(db, {
        workspaceSlug: setup.workspaceSlug,
        callSlug: setup.callSlug,
      })).toEqual({ available: false });

      const wrongRule = createCfpApplicantPortal({
        readRuleVersion: (database, workspaceId, ruleVersionId) => ({
          ...readRuleVersion(database, workspaceId, ruleVersionId),
          id: "rule_foreign",
        }),
      });
      expect(wrongRule.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      })).toEqual({ found: false });

      const malformedRule = createCfpApplicantPortal({
        readRuleVersion: (database, workspaceId, ruleVersionId) => ({
          ...readRuleVersion(database, workspaceId, ruleVersionId),
          schema: "cfp-form-rules/v2",
          organizerSecret: "account_private",
        }) as never,
      });
      expect(malformedRule.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      })).toEqual({ found: false });

      const malformedPolicy = createCfpApplicantPortal({
        readCall: (database, workspaceId, callId) => ({
          ...readCall(database, workspaceId, callId),
          policy: { disclosure: {}, choices: [] } as never,
        }),
      });
      expect(malformedPolicy.locateExternallyReachableCall(db, {
        workspaceSlug: setup.workspaceSlug,
        callSlug: setup.callSlug,
      })).toEqual({ available: false });

      const nonConsentPolicy = createCfpApplicantPortal({
        readCall: (database, workspaceId, callId) => {
          const call = readCall(database, workspaceId, callId);
          const content = {
            schema: call.policy.schema,
            policyVersionId: call.policy.policyVersionId,
            disclosure: call.policy.disclosure,
            choices: [{ fieldId: "title", statement: "Organizer-only title choice", required: true }],
          };
          const policy = {
            ...content,
            fingerprintAlgorithm: call.policy.fingerprintAlgorithm,
            fingerprint: fingerprintOf(content),
          };
          return { ...call, ...policy, policy };
        },
      });
      expect(nonConsentPolicy.locateExternallyReachableCall(db, {
        workspaceSlug: setup.workspaceSlug,
        callSlug: setup.callSlug,
      })).toEqual({ available: false });

      const organizerOnlyCall = createCfpApplicantPortal({
        readCall: (database, workspaceId, callId) => ({
          ...readCall(database, workspaceId, callId),
          organizerSecret: "account_private",
        }) as never,
      });
      expect(organizerOnlyCall.locateExternallyReachableCall(db, {
        workspaceSlug: setup.workspaceSlug,
        callSlug: setup.callSlug,
      })).toEqual({ available: false });

      const storedRevision = validSavedSeamEnvelope(db, setup).revision;
      const malformedRevision = createCfpApplicantPortal({
        readSubmissionRevision: () => ({
          ...storedRevision,
          schema: "cfp-submission-revision/v2",
          revisionNumber: 0,
          fingerprintAlgorithm: "sha256",
          organizerSecret: "account_private",
        }) as never,
      });
      expect(malformedRevision.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      })).toEqual({ found: false });

      const foreignPinnedRevision = refingerprintRevisionWithFormIds(
        storedRevision,
        "form_foreign",
        "rule_foreign",
      );
      let pinnedFormReads = 0;
      const foreignPins = createCfpApplicantPortal({
        readSubmissionRevision: () => foreignPinnedRevision,
        readFormVersionDocument: (database, workspaceId, formVersionId) => {
          pinnedFormReads += 1;
          return readFormVersionDocument(database, workspaceId, formVersionId);
        },
      });
      expect(foreignPins.readApplicantOwnedCurrentRevision(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
      })).toEqual({ found: false });
      expect(pinnedFormReads).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("preserves stale and terminal persistence semantics without trusting exact-prototype forgeries", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const saveInput = {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
        submissionId: setup.submissionId,
        historicalAnswers: [],
        expectedCurrentRevisionId: setup.revisionId,
      };
      for (const [persistenceCode, portalCode] of [
        ["STALE_REVISION", "SUBMISSION_STALE"],
        ["SUBMISSION_NOT_DRAFT", "SUBMISSION_NOT_DRAFT"],
        ["SUBMISSION_NOT_FOUND", "SUBMISSION_NOT_FOUND"],
      ] as const) {
        const portal = createCfpApplicantPortal({
          saveSubmissionDraft: () => {
            throw new FormDocumentPersistenceError(persistenceCode);
          },
        });
        expect(() => portal.saveApplicantSubmissionDraft(db, saveInput)).toThrowError(
          expect.objectContaining({ code: portalCode }),
        );
      }

      const genuineShape = new CfpApplicantAccessError("SESSION_INVALID");
      const forged = Object.create(CfpApplicantAccessError.prototype) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(genuineShape)) {
        const descriptor = Object.getOwnPropertyDescriptor(genuineShape, key);
        if (!descriptor) throw new Error("missing genuine error descriptor");
        Object.defineProperty(forged, key, descriptor);
      }
      const forgedPortal = createCfpApplicantPortal({
        issueEmailVerification: () => {
          throw forged;
        },
      });
      expect(() => forgedPortal.requestApplicantEmailVerification(db, {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        email: "applicant@example.test",
        tokenHash: "e".repeat(64),
      })).toThrowError(expect.objectContaining({ code: "PORTAL_WRITE_FAILED" }));
    } finally {
      closeDb(db);
    }
  });

  it("propagates fresh fatal command stops from create, save, and submit wrappers", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const fatal = Object.freeze(new CfpSubmissionCommandFatalError());
      const portal = createCfpApplicantPortal({
        createSubmissionDraft: () => { throw fatal; },
        saveSubmissionDraft: () => { throw fatal; },
        submitSubmission: () => { throw fatal; },
      });
      const base = {
        workspaceId: setup.workspaceId,
        callId: setup.callId,
        sessionTokenHash: setup.applicant.sessionTokenHash,
      };
      for (const invoke of [
        () => portal.createApplicantSubmissionDraft(db, base),
        () => portal.saveApplicantSubmissionDraft(db, {
          ...base,
          submissionId: setup.submissionId,
          historicalAnswers: [],
          expectedCurrentRevisionId: setup.revisionId,
        }),
        () => portal.submitApplicantSubmission(db, {
          ...base,
          submissionId: setup.submissionId,
          historicalAnswers: [],
          expectedCurrentRevisionId: setup.revisionId,
        }),
      ]) {
        try {
          invoke();
          expect.fail("expected fatal stop");
        } catch (error) {
          expect(error).toBeInstanceOf(CfpSubmissionCommandFatalError);
          expect(error).not.toBe(fatal);
          expect((error as CfpSubmissionCommandFatalError).fatal).toBe(true);
        }
      }
    } finally {
      closeDb(db);
    }
  });

  it("propagates a genuine O2C fatal when both owned-savepoint cleanup paths fail", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const setup = setupTestEnvironment(db);
      const before = db.prepare("SELECT COUNT(*) AS count FROM submissions").get() as {
        count: number;
      };
      db.exec("BEGIN IMMEDIATE");

      let ownedName: string | null = null;
      let releaseHits = 0;
      let execRollbackHits = 0;
      let preparedRollbackHits = 0;
      const cleanupDb = new Proxy(db, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string): void => {
              const release = /^RELEASE SAVEPOINT "(cfp_create_submission_draft_[a-f0-9]{32})"$/u.exec(
                sql,
              );
              if (ownedName === null && release?.[1]) {
                ownedName = release[1];
                releaseHits += 1;
                throw new Error("simulated pre-release O2C fault");
              }
              if (ownedName !== null && sql === `ROLLBACK TO SAVEPOINT "${ownedName}"`) {
                execRollbackHits += 1;
                throw new Error("simulated exec cleanup outage");
              }
              target.exec(sql);
            };
          }
          if (property === "prepare") {
            return (sql: string) => {
              if (ownedName !== null && sql === `ROLLBACK TO SAVEPOINT "${ownedName}"`) {
                preparedRollbackHits += 1;
                throw new Error("simulated prepared cleanup outage");
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;

      expect(() =>
        createApplicantSubmissionDraft(cleanupDb, {
          workspaceId: setup.workspaceId,
          callId: setup.callId,
          sessionTokenHash: setup.applicant.sessionTokenHash,
        }),
      ).toThrow(CfpSubmissionCommandFatalError);
      expect(releaseHits).toBe(1);
      expect(execRollbackHits).toBeGreaterThan(1);
      expect(preparedRollbackHits).toBeGreaterThan(1);
      expect(db.isTransaction).toBe(true);
      expect(
        (db.prepare("SELECT COUNT(*) AS count FROM submissions").get() as { count: number }).count,
      ).toBe(before.count);

      db.exec("ROLLBACK");
      expect(db.isTransaction).toBe(false);
      expect(
        (db.prepare("SELECT COUNT(*) AS count FROM submissions").get() as { count: number }).count,
      ).toBe(before.count);
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      closeDb(db);
    }
  });
});
