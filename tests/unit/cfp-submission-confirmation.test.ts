import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { Db } from "../../src/server/db";
import { closeDb, openDb } from "../../src/server/db";
import { canonicalJson } from "../../src/server/canonical";
import { createCfpApplicantAccess } from "../../src/server/services/cfp/applicant-access";
import {
  readApplicantSubmissionDashboard,
  readApplicantSubmissionDashboardForPortal,
} from "../../src/server/services/cfp/applicant-dashboard";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import {
  createCall,
  createCfpPersistence,
  createFormDefinition,
  readSubmissionRevision,
  sealFormVersion,
  type OrganizerContext,
  type SubmissionRevision,
} from "../../src/server/services/cfp/form-documents";
import {
  CFP_SUBMISSION_CONFIRMATION_EVENT_TYPE,
  queueCfpSubmissionConfirmation,
  readCfpSubmissionConfirmation,
} from "../../src/server/services/cfp/submission-confirmation";
import {
  createCfpSubmissionCommands,
  type CfpSubmissionCommandOptions,
  type CfpSubmissionCommands,
} from "../../src/server/services/cfp/submissions";

const FIXTURE_AT = "2026-08-10T00:00:00.000Z";
const COMMAND_AT = "2026-08-10T12:00:00.000Z";
const CALL_CLOSES_AT = "2099-01-01T00:00:00.000Z";
const SESSION_EXPIRES_AT = "2099-01-02T00:00:00.000Z";
const VERIFICATION_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

type ApplicantFixture = {
  readonly personId: string;
  readonly sessionId: string;
  readonly sessionTokenHash: string;
  readonly email: string;
};

type Fixture = {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly callId: string;
  readonly callSlug: string;
  readonly applicant: ApplicantFixture;
  readonly other: ApplicantFixture;
  readonly commands: CfpSubmissionCommands;
};

let db: Db | undefined;

afterEach(() => {
  if (db) closeDb(db);
  db = undefined;
});

function digest(label: string): string {
  return createHash("sha256").update(`cfp-confirmation-${label}`).digest("hex");
}

function insertApplicant(
  database: Db,
  workspaceId: string,
  callId: string,
  prefix: string,
): ApplicantFixture {
  const personId = `${prefix}-person`;
  const email = `${prefix}@confirmation.test`;
  const verificationId = `${prefix}-verification`;
  const sessionId = `${prefix}-session`;
  const sessionTokenHash = digest(`${prefix}-session-token`);
  const verificationTokenHash = digest(`${prefix}-verification-token`);
  database.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(personId, workspaceId, email, "Synthetic Applicant", FIXTURE_AT);
  database.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verificationId,
    workspaceId,
    callId,
    email,
    verificationTokenHash,
    VERIFICATION_EXPIRES_AT,
    FIXTURE_AT,
  );
  database.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`${prefix}-consumption`, workspaceId, verificationId, personId, FIXTURE_AT);
  database.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    workspaceId,
    callId,
    personId,
    verificationId,
    sessionTokenHash,
    FIXTURE_AT,
    SESSION_EXPIRES_AT,
  );
  return { personId, sessionId, sessionTokenHash, email };
}

function commandsAt(
  options?: CfpSubmissionCommandOptions,
): CfpSubmissionCommands {
  const access = createCfpApplicantAccess({ now: () => COMMAND_AT });
  const persistence = createCfpPersistence({ clock: () => COMMAND_AT });
  return createCfpSubmissionCommands({
    clock: () => COMMAND_AT,
    resolveApplicantSession: (database, input) => access.resolveApplicantSession(database, input),
    assertApplicantAccess: (database, input) => access.assertApplicantAccess(database, input),
    createDraftSubmission: (database, context, input) =>
      persistence.createDraftSubmission(database, context, input),
    saveDraftRevision: (database, context, input) =>
      persistence.saveDraftRevision(database, context, input),
    saveSubmittedAmendment: (database, context, input) =>
      persistence.saveSubmittedAmendment(database, context, input),
    ...options,
  });
}

function setupFixture(
  database: Db,
  options?: { readonly queueSubmissionConfirmation?: CfpSubmissionCommandOptions["queueSubmissionConfirmation"] },
): Fixture {
  const workspace = database.prepare(
    "SELECT id, slug FROM workspaces WHERE slug = 'northstar'",
  ).get() as { id: string; slug: string };
  const account = database.prepare(
    "SELECT id FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1",
  ).get(workspace.id) as { id: string };
  const organizer: OrganizerContext = { workspaceId: workspace.id, accountId: account.id };
  const persistence = createCfpPersistence({ clock: () => FIXTURE_AT });
  const eventId = "confirmation-event";
  database.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    workspace.id,
    "Confirmation Event",
    "UTC",
    FIXTURE_AT,
    CALL_CLOSES_AT,
    FIXTURE_AT,
  );
  const definition = persistence.createFormDefinition(database, organizer, {
    name: "Confirmation form",
  });
  const form = persistence.sealFormVersion(database, organizer, {
    formDefinitionId: definition.id,
    fields: [
      { id: "title", type: "shortText", label: "Proposal title", required: true, defaultVisibility: "visible" },
      { id: "consent", type: "consent", label: "Consent", required: true, defaultVisibility: "visible" },
    ],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const call = persistence.createCall(database, organizer, {
    eventId,
    name: "Confirmation Call",
    slug: "confirmation-call",
    formVersionId: form.id,
    policy: {
      disclosure: {
        privacy: "Organizer only",
        retention: "One year",
        aiProcessing: "No AI processing",
        communication: "Application updates",
        consent: "Terms",
        publication: "Accepted titles",
      },
      choices: [{ fieldId: "consent", statement: "Accept terms", required: true }],
    },
    accessMode: "PUBLIC",
    state: "OPEN",
    timezone: "UTC",
    opensAt: FIXTURE_AT,
    closesAt: CALL_CLOSES_AT,
  });
  return {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    callId: call.id,
    callSlug: "confirmation-call",
    applicant: insertApplicant(database, workspace.id, call.id, "confirmed-applicant"),
    other: insertApplicant(database, workspace.id, call.id, "other-applicant"),
    commands: commandsAt(options),
  };
}

function identity(fixture: Fixture, applicant = fixture.applicant) {
  return {
    workspaceId: fixture.workspaceId,
    callId: fixture.callId,
    sessionTokenHash: applicant.sessionTokenHash,
  };
}

function answers(title = "Durable CFP proposal") {
  return [
    { fieldId: "consent", value: true },
    { fieldId: "title", value: title },
  ];
}

function submitFixture(fixture: Fixture, title = "Durable CFP proposal") {
  const draft = fixture.commands.createSubmissionDraft(db!, identity(fixture));
  const saved = fixture.commands.saveSubmissionDraft(db!, {
    ...identity(fixture),
    submissionId: draft.id,
    historicalAnswers: answers(title),
    expectedCurrentRevisionId: null,
  });
  const submitted = fixture.commands.submitSubmission(db!, {
    ...identity(fixture),
    submissionId: draft.id,
    historicalAnswers: answers(title),
    expectedCurrentRevisionId: saved.revisionId,
  });
  return { draft, saved, ...submitted };
}

describe("CFP submission confirmation outbox", () => {
  it("queues one bounded local PENDING confirmation with canonical truthful payloads", () => {
    db = openDb({ path: ":memory:" });
    const fixture = setupFixture(db);
    const submitted = submitFixture(fixture);

    const eventRows = db.prepare(
      `SELECT id, payload_json, payload_fingerprint, created_at
       FROM domain_events
       WHERE workspace_id = ? AND event_type = ?`,
    ).all(fixture.workspaceId, CFP_SUBMISSION_CONFIRMATION_EVENT_TYPE) as Array<{
      id: string;
      payload_json: string;
      payload_fingerprint: string;
      created_at: string;
    }>;
    expect(eventRows).toHaveLength(1);
    const eventPayload = JSON.parse(eventRows[0]!.payload_json) as Record<string, unknown>;
    expect(canonicalJson(eventPayload)).toBe(eventRows[0]!.payload_json);
    expect(eventPayload).toMatchObject({
      workspaceId: fixture.workspaceId,
      callId: fixture.callId,
      submissionId: submitted.submissionId,
      submissionRevisionId: submitted.revisionId,
      recipientPersonId: fixture.applicant.personId,
      channel: "local-inbox-simulation",
      providerMutation: false,
    });
    expect(eventPayload).not.toHaveProperty("recipientEmail");

    const outbox = db.prepare(
      `SELECT workspace_id, domain_event_id, destination_key, payload_json,
              status, attempt_count, created_at
       FROM outbox_messages
       WHERE workspace_id = ?`,
    ).all(fixture.workspaceId) as Array<Record<string, unknown>>;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      workspace_id: fixture.workspaceId,
      domain_event_id: eventRows[0]!.id,
      destination_key: `cfp-submission-confirmation:${submitted.submissionId}:${submitted.revisionId}`,
      status: "PENDING",
      attempt_count: 0,
      created_at: eventRows[0]!.created_at,
    });
    const outboxPayload = JSON.parse(outbox[0]!.payload_json as string) as Record<string, unknown>;
    expect(canonicalJson(outboxPayload)).toBe(outbox[0]!.payload_json);
    expect(outboxPayload).toMatchObject({
      recipientPersonId: fixture.applicant.personId,
      recipientEmail: fixture.applicant.email,
      channel: "local-inbox-simulation",
      providerMutation: false,
    });
  });

  it("replays the same event and outbox row without duplicating either", () => {
    db = openDb({ path: ":memory:" });
    const fixture = setupFixture(db);
    const submitted = submitFixture(fixture);
    const revision: SubmissionRevision = readSubmissionRevision(
      db,
      fixture.workspaceId,
      submitted.revisionId,
    );
    const queueInput = {
      workspaceId: fixture.workspaceId,
      submissionId: submitted.submissionId,
      submissionRevisionId: submitted.revisionId,
      personId: fixture.applicant.personId,
      session: {
        workspaceId: fixture.workspaceId,
        sessionId: fixture.applicant.sessionId,
      },
      revision,
      queuedAt: submitted.submittedAt,
    } as const;
    const first = queueCfpSubmissionConfirmation(db, queueInput);
    const second = queueCfpSubmissionConfirmation(db, queueInput);
    expect(second).toEqual(first);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ?",
    ).get(CFP_SUBMISSION_CONFIRMATION_EVENT_TYPE)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual({ count: 1 });
    let replayFailure: unknown;
    try {
      fixture.commands.submitSubmission(db!, {
        ...identity(fixture),
        submissionId: submitted.submissionId,
        historicalAnswers: answers(),
        expectedCurrentRevisionId: submitted.revisionId,
      });
    } catch (error) {
      replayFailure = error;
    }
    expect(replayFailure).toMatchObject({ code: "SUBMISSION_NOT_DRAFT" });
  });

  it("rolls the submission revision and state back when confirmation queueing fails", () => {
    db = openDb({ path: ":memory:" });
    const fixture = setupFixture(db, {
      queueSubmissionConfirmation: () => {
        throw new Error("synthetic confirmation queue failure");
      },
    });
    const draft = fixture.commands.createSubmissionDraft(db, identity(fixture));
    const saved = fixture.commands.saveSubmissionDraft(db, {
      ...identity(fixture),
      submissionId: draft.id,
      historicalAnswers: answers(),
      expectedCurrentRevisionId: null,
    });
    let queueFailure: unknown;
    try {
      fixture.commands.submitSubmission(db!, {
        ...identity(fixture),
        submissionId: draft.id,
        historicalAnswers: answers(),
        expectedCurrentRevisionId: saved.revisionId,
      });
    } catch (error) {
      queueFailure = error;
    }
    expect(queueFailure).toMatchObject({ code: "SUBMISSION_WRITE_FAILED" });
    expect(db.prepare(
      "SELECT state, current_revision_id FROM submissions WHERE id = ?",
    ).get(draft.id)).toEqual({ state: "DRAFT", current_revision_id: saved.revisionId });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM submission_revisions WHERE submission_id = ?",
    ).get(draft.id)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual({ count: 0 });
  });

  it("rejects header/control injection before a submitted confirmation can commit", () => {
    db = openDb({ path: ":memory:" });
    const fixture = setupFixture(db);
    expect(() => submitFixture(fixture, "Legitimate title\r\nBcc: attacker@example.test"))
      .toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM submissions WHERE state = 'SUBMITTED'").get())
      .toEqual({ count: 0 });
  });

  it("projects an applicant-only masked receipt and preserves it across an amendment", () => {
    db = openDb({ path: ":memory:" });
    const fixture = setupFixture(db);
    const submitted = submitFixture(fixture);
    const before = readApplicantSubmissionDashboard(db, {
      ...identity(fixture),
      submissionId: submitted.submissionId,
    });
    expect(before?.confirmation).toMatchObject({
      submissionId: submitted.submissionId,
      submissionRevisionId: submitted.revisionId,
      subject: "CFP submission received: Durable CFP proposal",
      maskedRecipient: "c***t@confirmation.test",
      status: "PENDING",
      queuedAt: submitted.submittedAt,
      channel: "local-inbox-simulation",
      simulated: true,
      providerMutation: false,
    });
    expect(JSON.stringify(before)).not.toContain(fixture.applicant.email);

    const foreignApplicantView = readApplicantSubmissionDashboard(db, {
      ...identity(fixture, fixture.other),
      submissionId: submitted.submissionId,
    });
    expect(foreignApplicantView).toBeNull();
    const acme = db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { id: string };
    expect(readApplicantSubmissionDashboard(db, {
      workspaceId: acme.id,
      callId: fixture.callId,
      sessionTokenHash: fixture.applicant.sessionTokenHash,
      submissionId: submitted.submissionId,
    })).toBeNull();
    expect(readApplicantSubmissionDashboardForPortal(db, {
      workspaceSlug: "acme",
      callSlug: fixture.callSlug,
      sessionTokenHash: fixture.applicant.sessionTokenHash,
      submissionId: submitted.submissionId,
    })).toBeNull();

    const amended = fixture.commands.amendSubmittedSubmission(db, {
      ...identity(fixture),
      submissionId: submitted.submissionId,
      historicalAnswers: answers("Amended CFP proposal"),
      expectedCurrentRevisionId: submitted.revisionId,
    });
    const after = readApplicantSubmissionDashboard(db, {
      ...identity(fixture),
      submissionId: submitted.submissionId,
    });
    expect(amended.revisionId).not.toBe(submitted.revisionId);
    expect(after?.currentRevisionId).toBe(amended.revisionId);
    expect(after?.confirmation).toEqual(before?.confirmation);
    expect(readCfpSubmissionConfirmation(db, {
      workspaceId: fixture.workspaceId,
      callId: fixture.callId,
      submissionId: submitted.submissionId,
      personId: fixture.applicant.personId,
    })).toEqual(before?.confirmation);
  });
});
