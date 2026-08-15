import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionInfo } from "../../src/server/auth";
import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
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
  CfpDecisionError,
  decideCfpSubmission,
  readCfpSubmissionDecision,
} from "../../src/server/services/cfp/decisions";
import {
  createCall,
  createFormDefinition,
  readSubmissionRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";

const FIXTURE_AT = "2026-08-12T00:00:00.000Z";
const EVENT_ENDS_AT = "2099-01-01T00:00:00.000Z";

type Fixture = {
  readonly db: Db;
  readonly dbPath: string | null;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly callId: string;
  readonly callName: string;
  readonly submissionId: string;
  readonly revisionId: string;
  readonly revisionFingerprint: string;
  readonly applicantPersonId: string;
  readonly applicantName: string;
  readonly applicantEmail: string;
  readonly proposalTitle: string;
  readonly organizer: SessionInfo;
};

const openDatabases = new Set<Db>();
const temporaryDirectories = new Set<string>();

function digest(value: string): string {
  return createHash("sha256").update(`cfp-14-${value}`).digest("hex");
}

function trackedOpen(path: string): Db {
  const db = openDb({ path });
  openDatabases.add(db);
  return db;
}

function trackedClose(db: Db): void {
  if (openDatabases.delete(db)) closeDb(db);
}

function setupFixture(label: string, persistent = false): Fixture {
  const directory = persistent ? mkdtempSync(join(tmpdir(), "sympose-cfp-14-")) : null;
  if (directory) temporaryDirectories.add(directory);
  const dbPath = directory ? join(directory, "cfp-14.sqlite") : null;
  const db = trackedOpen(dbPath ?? ":memory:");
  const workspace = db.prepare("SELECT id, slug, name FROM workspaces WHERE slug = 'northstar'").get() as {
    id: string;
    slug: string;
    name: string;
  };
  const account = db.prepare(
    "SELECT id, email, display_name, role FROM accounts WHERE workspace_id = ? LIMIT 1",
  ).get(workspace.id) as { id: string; email: string; display_name: string; role: string };
  const organizer: SessionInfo = {
    id: `cfp-14-organizer-${label}`,
    tokenHash: digest(`organizer-${label}`),
    accountId: account.id,
    workspaceId: workspace.id,
    expiresAt: EVENT_ENDS_AT,
    email: account.email,
    displayName: account.display_name,
    role: account.role,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.name,
  };
  const eventId = `cfp-14-event-${label}`;
  const eventName = `Synthetic Event ${label}`;
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
  ).run(eventId, workspace.id, eventName, FIXTURE_AT, EVENT_ENDS_AT, FIXTURE_AT);

  const definition = createFormDefinition(db, organizer, { name: `CFP 14 form ${label}` });
  const form = sealFormVersion(db, organizer, {
    formDefinitionId: definition.id,
    fields: [
      { id: "title", type: "shortText", label: "Proposal title", required: true, defaultVisibility: "visible" },
      { id: "consent", type: "consent", label: "Accept terms", required: true, defaultVisibility: "visible" },
    ],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const callName = `Synthetic Call ${label}`;
  const call = createCall(db, organizer, {
    eventId,
    name: callName,
    slug: `cfp-14-call-${label}`,
    formVersionId: form.id,
    policy: {
      disclosure: {
        privacy: "Synthetic organizer-only fixture",
        retention: "Synthetic fixture only",
        aiProcessing: "No AI processing is used.",
        communication: "Local simulation only",
        consent: "Synthetic terms are recorded.",
        publication: "No publication from this fixture.",
      },
      choices: [{ fieldId: "consent", statement: "Accept terms", required: true }],
    },
    accessMode: "PUBLIC",
    state: "OPEN",
    timezone: "UTC",
    opensAt: FIXTURE_AT,
    closesAt: EVENT_ENDS_AT,
  });

  const applicantEmail = `${label}@cfp-14.test`;
  const applicantName = `Synthetic Applicant ${label}`;
  const verificationTokenHash = digest(`verification-${label}`);
  const verification = issueEmailVerification(db, { workspaceId: workspace.id }, {
    callId: call.id,
    email: applicantEmail,
    tokenHash: verificationTokenHash,
  });
  const sessionTokenHash = digest(`session-${label}`);
  const applicant = consumeEmailVerification(db, { workspaceId: workspace.id }, {
    callId: call.id,
    verificationId: verification.verificationId,
    verificationTokenHash,
    applicantSessionTokenHash: sessionTokenHash,
    fullName: applicantName,
  });
  const draft = createApplicantSubmissionDraft(db, {
    workspaceId: workspace.id,
    callId: call.id,
    sessionTokenHash,
  });
  const proposalTitle = `Synthetic Proposal ${label}`;
  const answers = [
    { fieldId: "title", value: proposalTitle },
    { fieldId: "consent", value: true },
  ] as const;
  const saved = saveApplicantSubmissionDraft(db, {
    workspaceId: workspace.id,
    callId: call.id,
    sessionTokenHash,
    submissionId: draft.submissionId,
    historicalAnswers: answers,
    expectedCurrentRevisionId: null,
  });
  const submitted = submitApplicantSubmission(db, {
    workspaceId: workspace.id,
    callId: call.id,
    sessionTokenHash,
    submissionId: draft.submissionId,
    historicalAnswers: answers,
    expectedCurrentRevisionId: saved.revisionId,
  });
  const revision = readSubmissionRevision(db, workspace.id, submitted.revisionId);
  return {
    db,
    dbPath,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    eventId,
    eventName,
    callId: call.id,
    callName,
    submissionId: draft.submissionId,
    revisionId: submitted.revisionId,
    revisionFingerprint: revision.fingerprint,
    applicantPersonId: applicant.personId,
    applicantName,
    applicantEmail,
    proposalTitle,
    organizer,
  };
}

function decisionInput(fixture: Fixture, selectedDecision: "ACCEPTED" | "REJECTED") {
  return {
    workspaceSlug: fixture.workspaceSlug,
    eventId: fixture.eventId,
    callId: fixture.callId,
    submissionId: fixture.submissionId,
    expectedRevisionId: fixture.revisionId,
    decision: selectedDecision,
  } as const;
}

type StoredOutbox = {
  readonly id: string;
  readonly workspace_id: string;
  readonly domain_event_id: string;
  readonly destination_key: string;
  readonly payload_json: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly claim_token: string | null;
  readonly lease_expires_at: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly last_error: string | null;
};

function storedEvidence(fixture: Fixture, decisionEventId: string) {
  const event = fixture.db.prepare(
    `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint, created_at
     FROM domain_events WHERE id = ?`,
  ).get(decisionEventId) as {
    id: string;
    workspace_id: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload_json: string;
    payload_fingerprint: string;
    created_at: string;
  };
  const outbox = fixture.db.prepare(
    `SELECT id, workspace_id, domain_event_id, destination_key, payload_json,
            status, attempt_count, next_attempt_at, claim_token, lease_expires_at,
            created_at, delivered_at, last_error
     FROM outbox_messages WHERE domain_event_id = ?`,
  ).get(decisionEventId) as StoredOutbox;
  return {
    event,
    outbox,
    eventPayload: JSON.parse(event.payload_json) as Record<string, unknown>,
    outboxPayload: JSON.parse(outbox.payload_json) as Record<string, unknown>,
  };
}

function readDecision(fixture: Fixture) {
  return readCfpSubmissionDecision(fixture.db, {
    workspaceId: fixture.workspaceId,
    submissionId: fixture.submissionId,
    currentRevisionId: fixture.revisionId,
  });
}

function expectReadFailure(fixture: Fixture): void {
  expect(() => readDecision(fixture)).toThrowError(new CfpDecisionError("DECISION_READ_FAILED"));
}

function insertOutboxCopy(
  fixture: Fixture,
  row: StoredOutbox,
  overrides: Partial<StoredOutbox>,
): void {
  const value = { ...row, ...overrides };
  fixture.db.prepare(
    `INSERT INTO outbox_messages
       (id, workspace_id, domain_event_id, destination_key, payload_json,
        status, attempt_count, next_attempt_at, claim_token, lease_expires_at,
        created_at, delivered_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    value.id,
    value.workspace_id,
    value.domain_event_id,
    value.destination_key,
    value.payload_json,
    value.status,
    value.attempt_count,
    value.next_attempt_at,
    value.claim_token,
    value.lease_expires_at,
    value.created_at,
    value.delivered_at,
    value.last_error,
  );
}

afterEach(() => {
  for (const db of [...openDatabases]) trackedClose(db);
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe("CFP-14 durable decision communication", () => {
  it.each([
    ["ACCEPTED", "cfp-decision-accepted-v1", "accepted"],
    ["REJECTED", "cfp-decision-rejected-v1", "rejected"],
  ] as const)("renders the fixed %s template with exact scoped merge values", (selectedDecision, templateKey, outcome) => {
    const fixture = setupFixture(selectedDecision.toLowerCase());
    const receipt = decideCfpSubmission(fixture.db, fixture.organizer, decisionInput(fixture, selectedDecision));
    const communication = receipt.communication;
    if (!communication || communication.evidenceVersion !== "rendered-v2") {
      throw new Error("expected rendered v2 communication evidence");
    }
    expect(communication).toMatchObject({
      evidenceVersion: "rendered-v2",
      status: "PENDING",
      recipientPersonId: fixture.applicantPersonId,
      recipientDisplayName: fixture.applicantName,
      recipientEmail: fixture.applicantEmail,
      templateKey,
      mergeValues: {
        eventName: fixture.eventName,
        callName: fixture.callName,
        proposalTitle: fixture.proposalTitle,
      },
      channel: "local-inbox-simulation",
      simulated: true,
      providerMutation: false,
    });
    expect(communication?.renderedSubject).toBe(
      `${fixture.eventName} — ${fixture.callName}: ${fixture.proposalTitle} ${outcome}`,
    );
    expect(communication?.renderedBody).toContain(fixture.applicantName);
    expect(communication?.renderedBody).toContain(fixture.eventName);
    expect(communication?.renderedBody).toContain(fixture.callName);
    expect(communication?.renderedBody).toContain(fixture.proposalTitle);
    expect(communication?.renderedBody.length).toBeLessThanOrEqual(4_000);

    const stored = storedEvidence(fixture, receipt.decisionEventId);
    const anchor = stored.eventPayload.communication as Record<string, unknown>;
    expect(canonicalJson(stored.eventPayload)).toBe(stored.event.payload_json);
    expect(fingerprintOf(stored.eventPayload)).toBe(stored.event.payload_fingerprint);
    expect(anchor).toMatchObject({
      schema: "cfp-decision-communication-anchor/v1",
      outboxMessageId: stored.outbox.id,
      destinationKey: stored.outbox.destination_key,
      status: "PENDING",
      attemptCount: 0,
      nextAttemptAt: stored.outbox.next_attempt_at,
      claimToken: null,
      leaseExpiresAt: null,
      createdAt: stored.outbox.created_at,
      deliveredAt: null,
      lastError: null,
      payloadFingerprint: communication.payloadFingerprint,
      payload: stored.outboxPayload,
    });
    expect(canonicalJson(anchor.payload)).toBe(stored.outbox.payload_json);
    expect(stored.outboxPayload).toMatchObject({
      schema: "cfp-decision-communication/v2",
      recipientDisplayName: fixture.applicantName,
      recipientEmail: fixture.applicantEmail,
      templateKey,
      renderedSubject: communication?.renderedSubject,
      renderedBody: communication?.renderedBody,
      providerMutation: false,
    });
    const { payloadFingerprint, ...payloadBasis } = stored.outboxPayload;
    expect(fingerprintOf(payloadBasis)).toBe(payloadFingerprint);
  });

  it("reads, reloads, and replays the same snapshotted outbox evidence without duplicates", () => {
    const fixture = setupFixture("replay", true);
    const input = decisionInput(fixture, "REJECTED");
    const first = decideCfpSubmission(fixture.db, fixture.organizer, input);
    const directRead = readDecision(fixture);
    expect(directRead?.communication).toEqual(first.communication);

    trackedClose(fixture.db);
    const reloadedDb = trackedOpen(fixture.dbPath!);
    const reloaded = readCfpSubmissionDecision(reloadedDb, {
      workspaceId: fixture.workspaceId,
      submissionId: fixture.submissionId,
      currentRevisionId: fixture.revisionId,
    });
    const replayed = decideCfpSubmission(reloadedDb, fixture.organizer, input);
    expect(reloaded?.communication).toEqual(first.communication);
    expect(replayed.replayed).toBe(true);
    expect(replayed.decisionEventId).toBe(first.decisionEventId);
    expect(replayed.communication).toEqual(first.communication);
    const counts = reloadedDb.prepare(
      `SELECT
         (SELECT COUNT(*) FROM domain_events WHERE id = ?) AS decisions,
         (SELECT COUNT(*) FROM outbox_messages WHERE domain_event_id = ?) AS messages`,
    ).get(first.decisionEventId, first.decisionEventId) as { decisions: number; messages: number };
    expect(counts).toEqual({ decisions: 1, messages: 1 });
  });

  it("fails closed when the anchored outbox row is deleted and reinserted with recomputed evidence", () => {
    const fixture = setupFixture("reinsert");
    const receipt = decideCfpSubmission(fixture.db, fixture.organizer, decisionInput(fixture, "REJECTED"));
    const { outbox } = storedEvidence(fixture, receipt.decisionEventId);
    fixture.db.prepare("DELETE FROM outbox_messages WHERE id = ?").run(outbox.id);
    insertOutboxCopy(fixture, outbox, { id: "cfp-14-reinserted-message" });

    expectReadFailure(fixture);
    expect(() => decideCfpSubmission(fixture.db, fixture.organizer, decisionInput(fixture, "REJECTED")))
      .toThrowError(new CfpDecisionError("DECISION_READ_FAILED"));
  });

  it("fails closed for mutable delivery status without durable delivery evidence", () => {
    const fixture = setupFixture("status");
    const receipt = decideCfpSubmission(fixture.db, fixture.organizer, decisionInput(fixture, "REJECTED"));
    fixture.db.prepare(
      "UPDATE outbox_messages SET status = 'DELIVERED', delivered_at = ? WHERE domain_event_id = ?",
    ).run(FIXTURE_AT, receipt.decisionEventId);

    expectReadFailure(fixture);
  });

  it("fails closed on an independently recomputed recipient and outbox payload mismatch", () => {
    const fixture = setupFixture("recipient-mismatch");
    const receipt = decideCfpSubmission(fixture.db, fixture.organizer, decisionInput(fixture, "REJECTED"));
    const { outbox, outboxPayload } = storedEvidence(fixture, receipt.decisionEventId);
    fixture.db.prepare("DELETE FROM outbox_messages WHERE id = ?").run(outbox.id);
    const { payloadFingerprint: _oldFingerprint, ...payloadBasis } = outboxPayload;
    const changedBasis = { ...payloadBasis, recipientEmail: "changed@cfp-14.test" };
    const changedFingerprint = fingerprintOf(changedBasis);
    const changedPayload = { ...changedBasis, payloadFingerprint: changedFingerprint };
    insertOutboxCopy(fixture, outbox, {
      payload_json: canonicalJson(changedPayload),
      destination_key: `cfp:${fixture.submissionId}:${fixture.applicantPersonId}:${receipt.decisionEventId}:${changedFingerprint}`,
    });

    expectReadFailure(fixture);
  });

  it("fails closed when the anchored row is missing or duplicated", () => {
    const missing = setupFixture("missing");
    const missingReceipt = decideCfpSubmission(missing.db, missing.organizer, decisionInput(missing, "REJECTED"));
    missing.db.prepare("DELETE FROM outbox_messages WHERE domain_event_id = ?").run(missingReceipt.decisionEventId);
    expectReadFailure(missing);

    const duplicate = setupFixture("duplicate");
    const duplicateReceipt = decideCfpSubmission(duplicate.db, duplicate.organizer, decisionInput(duplicate, "REJECTED"));
    const { outbox } = storedEvidence(duplicate, duplicateReceipt.decisionEventId);
    insertOutboxCopy(duplicate, outbox, {
      id: "cfp-14-duplicate-message",
      destination_key: `${outbox.destination_key}:duplicate`,
    });
    expectReadFailure(duplicate);
  });

  it("fails closed for foreign callers and cross-workspace outbox evidence", () => {
    const fixture = setupFixture("cross-workspace");
    const receipt = decideCfpSubmission(fixture.db, fixture.organizer, decisionInput(fixture, "REJECTED"));
    const foreignWorkspace = fixture.db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { id: string };
    expect(() => readCfpSubmissionDecision(fixture.db, {
      workspaceId: foreignWorkspace.id,
      submissionId: fixture.submissionId,
      currentRevisionId: fixture.revisionId,
    })).toThrowError(new CfpDecisionError("SUBMISSION_NOT_AVAILABLE"));

    const { outbox } = storedEvidence(fixture, receipt.decisionEventId);
    fixture.db.exec("DROP TRIGGER IF EXISTS trg_v12_outbox_workspace_guard");
    insertOutboxCopy(fixture, outbox, {
      id: "cfp-14-foreign-message",
      workspace_id: foreignWorkspace.id,
    });
    expectReadFailure(fixture);
  });
});
