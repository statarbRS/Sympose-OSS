import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createSession, type SessionInfo } from "../../src/server/auth";
import type { Db } from "../../src/server/db";
import { closeDb, openDb } from "../../src/server/db";
import {
  consumeEmailVerification,
  issueEmailVerification,
} from "../../src/server/services/cfp/applicant-access";
import {
  createApplicantSubmissionDraft,
  saveApplicantSubmissionDraft,
  submitApplicantSubmission,
} from "../../src/server/services/cfp/applicant-portal";
import {
  createCall,
  createFormDefinition,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import { readApplicantSubmissionDashboard } from "../../src/server/services/cfp/applicant-dashboard";
import {
  CfpDecisionError,
  decideCfpSubmission,
} from "../../src/server/services/cfp/decisions";
import { readCfpOrganizerCall } from "../../src/server/services/cfp/organizer";
import {
  amendSubmittedSubmission,
  saveSubmissionDraft,
} from "../../src/server/services/cfp/submissions";

const FIXTURE_AT = "2026-08-01T00:00:00.000Z";
const CALL_CLOSES_AT = "2099-01-01T00:00:00.000Z";

function digest(label: string): string {
  return createHash("sha256").update(`cfp-dashboard-${label}`).digest("hex");
}

let db: Db | undefined;

afterEach(() => {
  if (db) closeDb(db);
  db = undefined;
});

describe("CFP applicant dashboard and organizer round trip", () => {
  it("reads immutable receipt evidence, reports the open edit boundary, and locks after close", () => {
    db = openDb({ path: ":memory:" });
    const workspace = db.prepare("SELECT id, slug, name FROM workspaces WHERE slug = 'northstar'").get() as {
      id: string;
      slug: string;
      name: string;
    };
    const account = db.prepare(
      "SELECT id, email, display_name, role FROM accounts WHERE workspace_id = ? LIMIT 1",
    ).get(workspace.id) as {
      id: string;
      email: string;
      display_name: string;
      role: string;
    };
    const organizer = { workspaceId: workspace.id, accountId: account.id };
    const eventId = "dashboard-round-trip-event";
    db.prepare(
      `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      workspace.id,
      "Dashboard round trip",
      "UTC",
      FIXTURE_AT,
      CALL_CLOSES_AT,
      "planning",
      FIXTURE_AT,
    );

    const definition = createFormDefinition(db, organizer, { name: "Dashboard form" });
    const form = sealFormVersion(db, organizer, {
      formDefinitionId: definition.id,
      fields: [
        {
          id: "title",
          type: "shortText",
          label: "Proposal title",
          required: true,
          defaultVisibility: "visible",
        },
        {
          id: "consent",
          type: "consent",
          label: "Accept terms",
          required: true,
          defaultVisibility: "visible",
        },
      ],
      rules: { schema: FORM_RULES_SCHEMA, rules: [] },
    });
    const call = createCall(db, organizer, {
      eventId,
      name: "Dashboard Call",
      slug: "dashboard-call",
      formVersionId: form.id,
      policy: {
        disclosure: {
          privacy: "Organizer only",
          retention: "One year",
          aiProcessing: "No AI processing is used.",
          communication: "Application updates only",
          consent: "Required terms are recorded.",
          publication: "Accepted titles may be published.",
        },
        choices: [{ fieldId: "consent", statement: "Accept terms", required: true }],
      },
      accessMode: "PUBLIC",
      state: "OPEN",
      timezone: "UTC",
      opensAt: FIXTURE_AT,
      closesAt: CALL_CLOSES_AT,
    });

    const email = "applicant@dashboard.test";
    const verificationHash = digest("verification");
    const verification = issueEmailVerification(
      db,
      { workspaceId: workspace.id },
      { callId: call.id, email, tokenHash: verificationHash },
    );
    const sessionTokenHash = digest("session");
    consumeEmailVerification(
      db,
      { workspaceId: workspace.id },
      {
        callId: call.id,
        verificationId: verification.verificationId,
        verificationTokenHash: verificationHash,
        applicantSessionTokenHash: sessionTokenHash,
        fullName: "Dashboard Applicant",
      },
    );
    const submission = createApplicantSubmissionDraft(db, {
      workspaceId: workspace.id,
      callId: call.id,
      sessionTokenHash,
    });
    const answers = [
      { fieldId: "consent", value: true },
      { fieldId: "title", value: "A durable proposal" },
    ] as const;
    const saved = saveApplicantSubmissionDraft(db, {
      workspaceId: workspace.id,
      callId: call.id,
      sessionTokenHash,
      submissionId: submission.submissionId,
      historicalAnswers: answers,
      expectedCurrentRevisionId: null,
    });
    const submitted = submitApplicantSubmission(db, {
      workspaceId: workspace.id,
      callId: call.id,
      sessionTokenHash,
      submissionId: submission.submissionId,
      historicalAnswers: answers,
      expectedCurrentRevisionId: saved.revisionId,
    });

    const submittedRow = db.prepare(
      "SELECT state, current_revision_id, updated_at FROM submissions WHERE id = ?",
    ).get(submission.submissionId) as {
      state: string;
      current_revision_id: string;
      updated_at: string;
    };
    const submittedRevisionBefore = db.prepare(
      "SELECT revision_json FROM submission_revisions WHERE id = ?",
    ).get(submitted.revisionId) as { revision_json: string };
    const amendedAnswers = [
      { fieldId: "consent", value: true },
      { fieldId: "title", value: "A durable proposal · amended" },
    ] as const;
    const amended = amendSubmittedSubmission(db, {
      workspaceId: workspace.id,
      callId: call.id,
      sessionTokenHash,
      submissionId: submission.submissionId,
      historicalAnswers: amendedAnswers,
      expectedCurrentRevisionId: submitted.revisionId,
    });
    expect(amended.revision.revisionNumber).toBe(3);
    expect(amended.revisionId).not.toBe(submitted.revisionId);
    expect(db.prepare(
      "SELECT state, current_revision_id, updated_at FROM submissions WHERE id = ?",
    ).get(submission.submissionId)).toEqual({
      state: "SUBMITTED",
      current_revision_id: amended.revisionId,
      updated_at: submittedRow.updated_at,
    });
    expect(db.prepare(
      "SELECT revision_json FROM submission_revisions WHERE id = ?",
    ).get(submitted.revisionId)).toEqual(submittedRevisionBefore);
    expect(db.prepare(
      `SELECT expected_current_revision_id, revision_id
       FROM cfp_submission_amendment_markers
       WHERE submission_id = ?`,
    ).get(submission.submissionId)).toEqual({
      expected_current_revision_id: submitted.revisionId,
      revision_id: amended.revisionId,
    });

    let staleAmendment: unknown;
    try {
      amendSubmittedSubmission(db, {
        workspaceId: workspace.id,
        callId: call.id,
        sessionTokenHash,
        submissionId: submission.submissionId,
        historicalAnswers: amendedAnswers,
        expectedCurrentRevisionId: submitted.revisionId,
      });
    } catch (error) {
      staleAmendment = error;
    }
    expect(staleAmendment).toMatchObject({ code: "STALE_REVISION" });

    let genericDraftWrite: unknown;
    try {
      saveSubmissionDraft(db, {
        workspaceId: workspace.id,
        callId: call.id,
        sessionTokenHash,
        submissionId: submission.submissionId,
        historicalAnswers: amendedAnswers,
        expectedCurrentRevisionId: amended.revisionId,
      });
    } catch (error) {
      genericDraftWrite = error;
    }
    expect(genericDraftWrite).toMatchObject({ code: "SUBMISSION_NOT_DRAFT" });

    const callBeforeClose = db.prepare("SELECT updated_at FROM calls WHERE id = ?").get(call.id) as {
      updated_at: string;
    };
    const closeAt = new Date(Date.parse(callBeforeClose.updated_at) + 1).toISOString();
    db.prepare("UPDATE calls SET state = 'CLOSED', updated_at = ? WHERE id = ?").run(closeAt, call.id);
    let closedAmendment: unknown;
    try {
      amendSubmittedSubmission(db, {
        workspaceId: workspace.id,
        callId: call.id,
        sessionTokenHash,
        submissionId: submission.submissionId,
        historicalAnswers: amendedAnswers,
        expectedCurrentRevisionId: amended.revisionId,
      });
    } catch (error) {
      closedAmendment = error;
    }
    expect(closedAmendment).toMatchObject({ code: "CALL_NOT_ACCEPTING" });
    const reopenAt = new Date(Date.parse(closeAt) + 1).toISOString();
    db.prepare("UPDATE calls SET state = 'OPEN', updated_at = ? WHERE id = ?").run(reopenAt, call.id);

    const dashboard = readApplicantSubmissionDashboard(db, {
      workspaceId: workspace.id,
      callId: call.id,
      sessionTokenHash,
      submissionId: submission.submissionId,
    }, { now: () => Date.parse("2026-08-12T00:00:00.000Z") });
    expect(dashboard).not.toBeNull();
    expect(dashboard?.state).toBe("SUBMITTED");
    expect(dashboard?.currentRevisionId).toBe(amended.revisionId);
    expect(dashboard?.revisionNumber).toBe(3);
    expect(dashboard?.hasConsentReceipt).toBe(true);
    expect(dashboard?.submittedAt).toBe(submitted.submittedAt);
    expect(dashboard?.edit).toEqual({
      available: true,
      mode: "submitted-amendment",
      message:
        "This submitted proposal can be amended while the call is open. Saving creates a new immutable revision and preserves the submitted state.",
    });

    const organizerSession: SessionInfo = {
      id: "organizer-dashboard-session",
      tokenHash: digest("organizer-session"),
      accountId: account.id,
      workspaceId: workspace.id,
      expiresAt: "2099-01-01T00:00:00.000Z",
      email: account.email,
      displayName: account.display_name,
      role: account.role,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.name,
    };
    const organizerView = readCfpOrganizerCall(db, organizerSession, eventId, call.id);
    expect(organizerView.submissions).toHaveLength(1);
    expect(organizerView.submissions[0]).toMatchObject({
      submissionId: submission.submissionId,
      state: "SUBMITTED",
      currentRevisionId: amended.revisionId,
      revisionNumber: 3,
      hasConsentReceipt: true,
      lineageId: null,
      applicant: {
        displayName: "Dashboard Applicant",
      },
      answers: [
        { fieldId: "consent", value: true },
        { fieldId: "title", value: "A durable proposal · amended" },
      ],
    });

    const decisionReceipt = decideCfpSubmission(db, organizerSession, {
      workspaceSlug: workspace.slug,
      eventId,
      callId: call.id,
      submissionId: submission.submissionId,
      expectedRevisionId: amended.revisionId,
      decision: "ACCEPTED",
    });
    expect(decisionReceipt.replayed).toBe(false);
    expect(decisionReceipt.handoff).toMatchObject({
      title: "A durable proposal · amended",
      sourceRevisionId: amended.revisionId,
      speaker: { displayName: "Dashboard Applicant" },
    });
    expect(decisionReceipt.handoff?.note).toContain("real event program session is linked");
    expect(decisionReceipt.handoff?.linkedSession.status).toBe("UNSCHEDULED");
    expect(decisionReceipt.communication).toMatchObject({
      channel: "local-inbox-simulation",
      status: "PENDING",
      simulated: true,
      providerMutation: false,
    });
    expect(() => decideCfpSubmission(db!, organizerSession, {
      workspaceSlug: workspace.slug,
      eventId,
      callId: call.id,
      submissionId: submission.submissionId,
      expectedRevisionId: amended.revisionId,
      decision: "REJECTED",
    })).toThrowError(new CfpDecisionError("DECISION_ALREADY_RECORDED"));
    const applicantDecision = readApplicantSubmissionDashboard(db, {
      workspaceId: workspace.id,
      callId: call.id,
      sessionTokenHash,
      submissionId: submission.submissionId,
    }, { now: () => Date.parse("2026-08-12T00:00:00.000Z") });
    expect(applicantDecision?.decision).toMatchObject({
      decision: "ACCEPTED",
      communication: { channel: "local-inbox-simulation", providerMutation: false },
    });
    expect(applicantDecision?.decision?.communication).not.toHaveProperty("recipientEmail");
    expect(applicantDecision?.decision?.communication?.message).not.toContain("@");
    expect(applicantDecision?.edit).toEqual({
      available: false,
      code: "SUBMISSION_NOT_EDITABLE",
      message: "This submitted proposal has an organizer decision and cannot be amended.",
    });
    let decidedAmendment: unknown;
    try {
      amendSubmittedSubmission(db, {
        workspaceId: workspace.id,
        callId: call.id,
        sessionTokenHash,
        submissionId: submission.submissionId,
        historicalAnswers: amendedAnswers,
        expectedCurrentRevisionId: amended.revisionId,
      });
    } catch (error) {
      decidedAmendment = error;
    }
    expect(decidedAmendment).toMatchObject({ code: "SUBMISSION_AMENDMENT_NOT_ALLOWED" });

    const acmeWorkspace = db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { id: string };
    const acmeAccount = db.prepare(
      "SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' LIMIT 1",
    ).get(acmeWorkspace.id) as { id: string };
    const acmeSession = createSession(db, acmeAccount.id, acmeWorkspace.id).session;
    expect(() => amendSubmittedSubmission(db!, {
      workspaceId: acmeWorkspace.id,
      callId: call.id,
      sessionTokenHash,
      submissionId: submission.submissionId,
      historicalAnswers: amendedAnswers,
      expectedCurrentRevisionId: amended.revisionId,
    })).toThrow();
    expect(() => decideCfpSubmission(db!, acmeSession, {
      workspaceSlug: "acme",
      eventId,
      callId: call.id,
      submissionId: submission.submissionId,
      expectedRevisionId: amended.revisionId,
      decision: "REJECTED",
    })).toThrowError(new CfpDecisionError("SUBMISSION_NOT_AVAILABLE"));

    const priorCall = db.prepare("SELECT updated_at FROM calls WHERE id = ?").get(call.id) as {
      updated_at: string;
    };
    const closureAt = new Date(Math.max(Date.now(), Date.parse(priorCall.updated_at) + 1)).toISOString();
    db.prepare("UPDATE calls SET state = ?, updated_at = ? WHERE id = ?").run(
      "CLOSED",
      closureAt,
      call.id,
    );
    const closedDashboard = readApplicantSubmissionDashboard(db, {
      workspaceId: workspace.id,
      callId: call.id,
      sessionTokenHash,
      submissionId: submission.submissionId,
    }, { now: () => Date.parse("2026-08-12T00:00:00.000Z") });
    expect(closedDashboard?.edit).toEqual({
      available: false,
      code: "CALL_CLOSED",
      message: "Editing is locked because this call is no longer accepting applications.",
    });
  });
});
