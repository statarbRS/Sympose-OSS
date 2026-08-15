import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { SessionInfo } from "../../src/server/auth";
import { createSession } from "../../src/server/auth";
import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import { ApplicantDashboard } from "../../src/components/cfp/applicant-dashboard";
import {
  consumeEmailVerification,
  issueEmailVerification,
} from "../../src/server/services/cfp/applicant-access";
import { readApplicantSubmissionDashboard } from "../../src/server/services/cfp/applicant-dashboard";
import {
  createApplicantSubmissionDraft,
  saveApplicantSubmissionDraft,
  submitApplicantSubmission,
} from "../../src/server/services/cfp/applicant-portal";
import { amendSubmittedSubmission } from "../../src/server/services/cfp/submissions";
import {
  createCall,
  createFormDefinition,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import {
  bindSubmissionToLineage,
  createProposalLineage,
} from "../../src/server/services/cfp/proposal-lineage";
import {
  CfpDecisionError,
  decideCfpSubmission,
  readAcceptedCfpScheduleInventory,
} from "../../src/server/services/cfp/decisions";
import {
  readCurrentReleasedCfpSession,
  sealRelease,
  validatePublicReleaseForRead,
} from "../../src/server/services/publication";
import { approvePlan } from "../../src/server/services/planning";
import {
  commitmentResponseCommandKey,
  deliverOffers,
  respondToOfferCommand,
} from "../../src/server/services/commitments";
import { createSyntheticSpeakerOperationsRepository } from "../../src/server/services/speaker-operations";
import { readCanonicalScheduleAuthorityAt } from "../../src/server/services/scheduling/canonical";
import {
  executeScheduleDraftCommand,
  findScheduleDraftAuthorityEvidence,
  readScheduleDraft,
} from "../../src/server/services/scheduling/persistence";
import { persistAndApproveCurrentSchedule } from "../helpers/schedule-approval";

const FIXTURE_AT = "2026-08-01T00:00:00.000Z";
const EVENT_STARTS_AT = "2026-09-18T09:00:00.000Z";
const EVENT_ENDS_AT = "2026-09-18T17:00:00.000Z";
const ACCESS_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

type Fixture = {
  readonly db: Db;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly eventId: string;
  readonly callId: string;
  readonly submissionId: string;
  readonly revisionId: string;
  readonly applicantPersonId: string;
  readonly sessionTokenHash: string;
  readonly organizer: SessionInfo;
};

interface ProposalFixtureOptions {
  readonly title?: string;
  readonly abstract?: string;
  readonly format?: string;
  readonly track?: string | null;
  readonly trackRequired?: boolean;
  readonly durationMinutes?: number | null;
  readonly formatDurationMinutes?: number | null;
}

let databases: Db[] = [];

function digest(value: string): string {
  return createHash("sha256").update(`cfp-15-${value}`).digest("hex");
}

function setupFixture(label: string, options: ProposalFixtureOptions = {}): Fixture {
  const db = openDb({ path: ":memory:" });
  databases.push(db);
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
  const organizer: SessionInfo = {
    id: `cfp-15-organizer-session-${label}`,
    tokenHash: digest(`organizer-${label}`),
    accountId: account.id,
    workspaceId: workspace.id,
    expiresAt: ACCESS_EXPIRES_AT,
    email: account.email,
    displayName: account.display_name,
    role: account.role,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.name,
  };
  const eventId = `cfp-15-event-${label}`;
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
  ).run(eventId, workspace.id, `CFP 15 ${label}`, EVENT_STARTS_AT, EVENT_ENDS_AT, FIXTURE_AT);

  const definition = createFormDefinition(db, organizer, { name: `CFP 15 form ${label}` });
  const form = sealFormVersion(db, organizer, {
    formDefinitionId: definition.id,
    fields: [
      { id: "title", type: "shortText", label: "Proposal title", required: true, defaultVisibility: "visible" },
      { id: "abstract", type: "longText", label: "Proposal abstract", required: true, defaultVisibility: "visible", config: { maxLength: 4000 } },
      {
        id: "format",
        type: "shortText",
        label: "Session format",
        required: false,
        defaultVisibility: "visible",
        ...(options.formatDurationMinutes === undefined || options.formatDurationMinutes === null
          ? {}
          : { config: { durationMinutes: options.formatDurationMinutes } }),
      },
      {
        id: "track",
        type: "shortText",
        label: "Track",
        required: options.trackRequired ?? false,
        defaultVisibility: "visible",
      },
      { id: "durationMinutes", type: "shortText", label: "Session duration", required: false, defaultVisibility: "visible" },
      { id: "consent", type: "consent", label: "Accept terms", required: true, defaultVisibility: "visible" },
    ],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const call = createCall(db, organizer, {
    eventId,
    name: `CFP 15 call ${label}`,
    slug: `cfp-15-call-${label}`,
    formVersionId: form.id,
    policy: {
      disclosure: {
        privacy: "Organizer only",
        retention: "One year",
        aiProcessing: "No AI processing is used.",
        communication: "Application updates only",
        consent: "Required terms are recorded.",
        publication: "Accepted proposals require later publication review.",
      },
      choices: [{ fieldId: "consent", statement: "Accept terms", required: true }],
    },
    accessMode: "PUBLIC",
    state: "OPEN",
    timezone: "UTC",
    opensAt: FIXTURE_AT,
    closesAt: ACCESS_EXPIRES_AT,
  });

  const verificationHash = digest(`verification-${label}`);
  const verification = issueEmailVerification(db, {
    workspaceId: workspace.id,
  }, {
    callId: call.id,
    email: `${label}@cfp-15.test`,
    tokenHash: verificationHash,
  });
  const sessionTokenHash = digest(`applicant-session-${label}`);
  const consumed = consumeEmailVerification(db, {
    workspaceId: workspace.id,
  }, {
    callId: call.id,
    verificationId: verification.verificationId,
    verificationTokenHash: verificationHash,
    applicantSessionTokenHash: sessionTokenHash,
    fullName: `CFP 15 Applicant ${label}`,
  });
  const draft = createApplicantSubmissionDraft(db, {
    workspaceId: workspace.id,
    callId: call.id,
    sessionTokenHash,
  });
  const answers: Array<{ readonly fieldId: string; readonly value: string | boolean }> = [
    { fieldId: "title", value: options.title ?? `Accepted proposal ${label}` },
    { fieldId: "abstract", value: options.abstract ?? "A proposal that becomes a real unscheduled program session." },
    { fieldId: "format", value: options.format ?? "Workshop" },
    ...(options.track === null ? [] : [{ fieldId: "track", value: options.track ?? "Trust" }]),
    ...(options.durationMinutes === undefined || options.durationMinutes === null
      ? []
      : [{ fieldId: "durationMinutes", value: String(options.durationMinutes) }]),
    { fieldId: "consent", value: true },
  ];
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

  return {
    db,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    eventId,
    callId: call.id,
    submissionId: draft.submissionId,
    revisionId: submitted.revisionId,
    applicantPersonId: consumed.personId,
    sessionTokenHash,
    organizer,
  };
}

function addSubmittedProposal(
  fixture: Fixture,
  label: string,
  options: ProposalFixtureOptions = {},
): {
  readonly submissionId: string;
  readonly revisionId: string;
  readonly personId: string;
  readonly title: string;
} {
  const verificationHash = digest(`additional-verification-${label}`);
  const verification = issueEmailVerification(fixture.db, {
    workspaceId: fixture.workspaceId,
  }, {
    callId: fixture.callId,
    email: `${label}@cfp-15.test`,
    tokenHash: verificationHash,
  });
  const sessionTokenHash = digest(`additional-applicant-session-${label}`);
  const applicant = consumeEmailVerification(fixture.db, {
    workspaceId: fixture.workspaceId,
  }, {
    callId: fixture.callId,
    verificationId: verification.verificationId,
    verificationTokenHash: verificationHash,
    applicantSessionTokenHash: sessionTokenHash,
    fullName: `CFP 15 Additional Applicant ${label}`,
  });
  const draft = createApplicantSubmissionDraft(fixture.db, {
    workspaceId: fixture.workspaceId,
    callId: fixture.callId,
    sessionTokenHash,
  });
  const title = options.title ?? `Accepted proposal ${label}`;
  const answers: Array<{ readonly fieldId: string; readonly value: string | boolean }> = [
    { fieldId: "title", value: title },
    { fieldId: "abstract", value: options.abstract ?? "A later accepted proposal added to the same scheduler authority." },
    { fieldId: "format", value: options.format ?? "Talk" },
    ...(options.track === null ? [] : [{ fieldId: "track", value: options.track ?? "Operations" }]),
    ...(options.durationMinutes === undefined || options.durationMinutes === null
      ? []
      : [{ fieldId: "durationMinutes", value: String(options.durationMinutes) }]),
    { fieldId: "consent", value: true },
  ];
  const saved = saveApplicantSubmissionDraft(fixture.db, {
    workspaceId: fixture.workspaceId,
    callId: fixture.callId,
    sessionTokenHash,
    submissionId: draft.submissionId,
    historicalAnswers: answers,
    expectedCurrentRevisionId: null,
  });
  const submitted = submitApplicantSubmission(fixture.db, {
    workspaceId: fixture.workspaceId,
    callId: fixture.callId,
    sessionTokenHash,
    submissionId: draft.submissionId,
    historicalAnswers: answers,
    expectedCurrentRevisionId: saved.revisionId,
  });
  return {
    submissionId: draft.submissionId,
    revisionId: submitted.revisionId,
    personId: applicant.personId,
    title,
  };
}

function count(db: Db, table: string, where = "1 = 1", ...parameters: string[]): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...parameters) as { count: number };
  return row.count;
}

function decisionEvent(db: Db, fixture: Fixture): { id: string; payload: Record<string, unknown> } {
  const row = db.prepare(
    `SELECT id, payload_json
     FROM domain_events
     WHERE workspace_id = ? AND event_type = 'cfp.submission.decision' AND aggregate_id = ?
     LIMIT 1`,
  ).get(fixture.workspaceId, fixture.submissionId) as { id: string; payload_json: string };
  return { id: row.id, payload: JSON.parse(row.payload_json) as Record<string, unknown> };
}

function rewriteDecisionAsLegacyV1(fixture: Fixture): void {
  const stored = decisionEvent(fixture.db, fixture);
  const handoff = stored.payload.sessionHandoff as Record<string, unknown>;
  const programUnitId = handoff.programUnitId;
  if (typeof programUnitId !== "string") throw new Error("expected source handoff program unit");
  const legacyHandoff = {
    schema: "cfp-session-handoff/v1",
    eventId: handoff.eventId,
    programUnitId: handoff.programUnitId,
    sourceSubmissionId: handoff.sourceSubmissionId,
    sourceRevisionId: handoff.sourceRevisionId,
    sourceRevisionFingerprint: handoff.sourceRevisionFingerprint,
    speakerPersonId: handoff.speakerPersonId,
    speakerLinkId: handoff.speakerLinkId,
    createdStatus: "UNSCHEDULED",
  };
  const communication = stored.payload.communication as Record<string, unknown>;
  const priorCommunicationPayload = communication.payload as Record<string, unknown>;
  const communicationBasis: Record<string, unknown> = {
    ...priorCommunicationPayload,
    sessionHandoff: legacyHandoff,
  };
  delete communicationBasis.payloadFingerprint;
  const communicationFingerprint = fingerprintOf(communicationBasis);
  const communicationPayload: Record<string, unknown> = {
    ...communicationBasis,
    payloadFingerprint: communicationFingerprint,
  };
  const destinationKey = [
    "cfp",
    stored.payload.submissionId,
    communicationPayload.recipientPersonId,
    stored.id,
    communicationFingerprint,
  ].join(":");
  const legacyPayload = {
    ...stored.payload,
    schema: "cfp-submission-decision/v2",
    sessionHandoff: legacyHandoff,
    communication: {
      ...communication,
      destinationKey,
      payloadFingerprint: communicationFingerprint,
      payload: communicationPayload,
    },
  };
  fixture.db.exec(
    `DROP TRIGGER trg_v12_domain_events_immutable;
     DROP TRIGGER trg_v12_outbox_workspace_update_guard;`,
  );
  fixture.db.prepare(
    `UPDATE domain_events SET payload_json = ?, payload_fingerprint = ? WHERE id = ? AND workspace_id = ?`,
  ).run(canonicalJson(legacyPayload), fingerprintOf(legacyPayload), stored.id, fixture.workspaceId);
  fixture.db.prepare(
    `UPDATE outbox_messages SET destination_key = ?, payload_json = ? WHERE domain_event_id = ? AND workspace_id = ?`,
  ).run(destinationKey, canonicalJson(communicationPayload), stored.id, fixture.workspaceId);
  fixture.db.prepare(
    `UPDATE program_units
        SET name = ?, starts_at = ?, ends_at = ?, capacity = 0
      WHERE workspace_id = ? AND event_id = ? AND id = ?`,
  ).run(
    `Accepted proposal ${fixture.eventId.replace("cfp-15-event-", "")}`,
    EVENT_STARTS_AT,
    EVENT_ENDS_AT,
    fixture.workspaceId,
    fixture.eventId,
    programUnitId,
  );
}

function installApprovedPlan(
  fixture: Fixture,
  programUnitId: string,
  versionNumber = 1,
  supersedesPlanVersionId: string | null = null,
  assignments: readonly {
    readonly assignmentId: string;
    readonly personId: string;
    readonly programUnitId: string;
    readonly assignmentType: string;
    readonly explanation: string;
  }[] = [],
): {
  readonly planVersionId: string;
  readonly planFingerprint: string;
} {
  const suffix = digest(`plan-${fixture.eventId}-${versionNumber}`).slice(0, 20);
  const runId = `cfp-15-run-${suffix}`;
  const planVersionId = `cfp-15-plan-${suffix}`;
  const inputManifest = {
    schema: "cfp-15-scheduler-authority-input/v1",
    eventId: fixture.eventId,
    programUnitIds: [programUnitId, ...assignments.map((assignment) => assignment.programUnitId)].sort(),
  };
  const inputFingerprint = fingerprintOf(inputManifest);
  const event = fixture.db.prepare(
    `SELECT name, timezone, starts_at AS startsAt, ends_at AS endsAt
       FROM events WHERE workspace_id = ? AND id = ?`,
  ).get(fixture.workspaceId, fixture.eventId) as {
    name: string;
    timezone: string;
    startsAt: string;
    endsAt: string;
  };
  const content = {
    schema: "plan-version/v1",
    eventId: fixture.eventId,
    eventName: event.name,
    timezone: event.timezone,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    runId,
    inputFingerprint,
    snapshotFingerprint: fingerprintOf({ schema: "cfp-15-empty-plan-snapshot/v1", eventId: fixture.eventId, versionNumber }),
    versionNumber,
    assignments: assignments.map((assignment) => ({
      personId: assignment.personId,
      programUnitId: assignment.programUnitId,
      assignmentType: assignment.assignmentType,
      explanation: assignment.explanation,
    })),
    exclusions: [],
    diagnostics: { messages: [], unitCounts: {}, moderatorsWithoutUnit: [] },
  };
  const planFingerprint = fingerprintOf(content);
  fixture.db.prepare(
    `INSERT INTO plan_runs
       (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json,
        compiler, compiler_version, created_at)
     VALUES (?, ?, ?, 'FEASIBLE', ?, ?, 'cfp-15-lineage-proof', '1', ?)`,
  ).run(
    runId,
    fixture.workspaceId,
    fixture.eventId,
    inputFingerprint,
    canonicalJson(inputManifest),
    FIXTURE_AT,
  );
  fixture.db.prepare(
    `INSERT INTO plan_versions
       (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    planVersionId,
    fixture.workspaceId,
    fixture.eventId,
    runId,
    versionNumber,
    planFingerprint,
    canonicalJson(content),
    FIXTURE_AT,
  );
  const insertAssignment = fixture.db.prepare(
    `INSERT INTO plan_assignments
       (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const assignment of assignments) {
    insertAssignment.run(
      assignment.assignmentId,
      fixture.workspaceId,
      planVersionId,
      assignment.personId,
      assignment.programUnitId,
      assignment.assignmentType,
      assignment.explanation,
    );
  }
  fixture.db.prepare(
    `INSERT INTO plan_states
       (id, workspace_id, plan_version_id, state, actor_account_id, reason, created_at)
     VALUES (?, ?, ?, 'candidate', ?, NULL, ?)`,
  ).run(`cfp-15-plan-state-${suffix}`, fixture.workspaceId, planVersionId, fixture.organizer.accountId, FIXTURE_AT);
  approvePlan(
    fixture.db,
    fixture.workspaceId,
    fixture.eventId,
    planVersionId,
    supersedesPlanVersionId,
    { kind: "account", ref: fixture.organizer.accountId },
  );
  return { planVersionId, planFingerprint };
}

function approveExactSessionContent(
  fixture: Fixture,
  personId: string,
  label: string,
  content: { readonly title: string; readonly description: string },
) {
  const speaker = createSyntheticSpeakerOperationsRepository({ db: fixture.db, clock: () => FIXTURE_AT });
  const organizerScope = {
    kind: "organizer" as const,
    workspaceId: fixture.workspaceId,
    eventId: fixture.eventId,
    actorId: fixture.organizer.accountId,
  };
  const titleTask = speaker.createTask(organizerScope, {
    personId,
    kind: "SESSION_TITLE",
    contentKind: "SESSION_TITLE",
    title: `${label} title task`,
    description: "Exact public title.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2026-08-25T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: `cfp-15-${label}-title-task`,
  });
  const descriptionTask = speaker.createTask(organizerScope, {
    personId,
    kind: "SESSION_DESCRIPTION",
    contentKind: "SESSION_DESCRIPTION",
    title: `${label} description task`,
    description: "Exact public abstract.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2026-08-25T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: `cfp-15-${label}-description-task`,
  });
  const title = speaker.submitOrganizerContent(organizerScope, {
    personId,
    taskId: titleTask.id,
    payload: { kind: "SESSION_TITLE", title: content.title },
    idempotencyKey: `cfp-15-${label}-title-version`,
  });
  const description = speaker.submitOrganizerContent(organizerScope, {
    personId,
    taskId: descriptionTask.id,
    payload: { kind: "SESSION_DESCRIPTION", description: content.description },
    idempotencyKey: `cfp-15-${label}-description-version`,
  });
  speaker.approveContent(organizerScope, {
    personId,
    taskId: titleTask.id,
    submissionVersionId: title.id,
    submissionContentHash: title.contentHash,
    gate: "PUBLICATION",
    idempotencyKey: `cfp-15-${label}-title-approval`,
  });
  speaker.approveContent(organizerScope, {
    personId,
    taskId: descriptionTask.id,
    submissionVersionId: description.id,
    submissionContentHash: description.contentHash,
    gate: "PUBLICATION",
    idempotencyKey: `cfp-15-${label}-description-approval`,
  });
  return { speaker, organizerScope, titleTask, descriptionTask, title, description };
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
});

describe("CFP-15 accepted proposal session handoff", () => {
  it("creates one real event session with immutable revision and speaker evidence, unscheduled", () => {
    const fixture = setupFixture("accepted");
    const beforeOutbox = count(fixture.db, "outbox_messages");

    const receipt = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    });

    expect(receipt.replayed).toBe(false);
    expect(receipt.handoff).toMatchObject({
      title: "Accepted proposal accepted",
      abstract: "A proposal that becomes a real unscheduled program session.",
      format: "Workshop",
      track: "Trust",
      sourceSubmissionId: fixture.submissionId,
      sourceRevisionId: fixture.revisionId,
      speaker: { personId: fixture.applicantPersonId },
      linkedSession: {
        eventId: fixture.eventId,
        capacity: 1,
        durationMinutes: 45,
        trackName: "Trust",
        status: "UNSCHEDULED",
      },
    });
    const programUnitId = receipt.handoff?.linkedSession.programUnitId;
    const proposalLineageId = receipt.handoff?.linkedSession.proposalLineageId;
    expect(programUnitId).toEqual(expect.any(String));
    expect(proposalLineageId).toEqual(expect.any(String));
    if (!programUnitId || !proposalLineageId) throw new Error("expected lineage-bound session identifiers");
    expect(fixture.db.prepare(
      `SELECT id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity
       FROM program_units WHERE workspace_id = ? AND event_id = ?`,
    ).all(fixture.workspaceId, fixture.eventId)).toEqual([{
      id: programUnitId,
      workspace_id: fixture.workspaceId,
      event_id: fixture.eventId,
      name: `CFP session ${programUnitId}`,
      unit_type: "session",
      starts_at: EVENT_STARTS_AT,
      ends_at: "2026-09-18T09:45:00.000Z",
      capacity: 1,
    }]);
    expect(fixture.db.prepare(
      `SELECT id, workspace_id, originating_submission_id, originating_submission_revision_id,
              display_projection_json, created_by_account_id
       FROM proposal_lineages WHERE workspace_id = ? AND id = ?`,
    ).get(fixture.workspaceId, proposalLineageId)).toEqual({
      id: proposalLineageId,
      workspace_id: fixture.workspaceId,
      originating_submission_id: fixture.submissionId,
      originating_submission_revision_id: fixture.revisionId,
      display_projection_json: canonicalJson({
        schema: "cfp-accepted-proposal-display/v1",
        title: "Accepted proposal accepted",
        abstract: "A proposal that becomes a real unscheduled program session.",
        format: "Workshop",
        track: "Trust",
      }),
      created_by_account_id: fixture.organizer.accountId,
    });
    expect(fixture.db.prepare(
      "SELECT lineage_id FROM submissions WHERE workspace_id = ? AND id = ?",
    ).get(fixture.workspaceId, fixture.submissionId)).toEqual({ lineage_id: proposalLineageId });
    expect(fixture.db.prepare(
      `SELECT person_id, role_key, participation_status
       FROM event_speakers WHERE workspace_id = ? AND event_id = ?`,
    ).all(fixture.workspaceId, fixture.eventId)).toEqual([{
      person_id: fixture.applicantPersonId,
      role_key: "SPEAKER",
      participation_status: "INVITED",
    }]);
    expect(count(fixture.db, "event_session_allocations", "workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId)).toBe(0);
    expect(count(fixture.db, "outbox_messages")).toBe(beforeOutbox + 1);

    const stored = decisionEvent(fixture.db, fixture);
    expect(stored.payload.sessionHandoff).toMatchObject({
      eventId: fixture.eventId,
      programUnitId,
      proposalLineageId,
      sourceSubmissionId: fixture.submissionId,
      sourceRevisionId: fixture.revisionId,
      sourceRevisionFingerprint: receipt.submissionRevisionFingerprint,
      speakerPersonId: fixture.applicantPersonId,
      capacity: 1,
      durationMinutes: 45,
      durationSource: "CANONICAL_DEFAULT",
      startsAt: EVENT_STARTS_AT,
      endsAt: "2026-09-18T09:45:00.000Z",
      proposalTrack: "Trust",
      trackName: "Trust",
      trackSource: "PROPOSAL",
      createdStatus: "UNSCHEDULED",
    });
    const communication = fixture.db.prepare(
      `SELECT payload_json
       FROM outbox_messages
       WHERE workspace_id = ? AND domain_event_id = ?`,
    ).get(fixture.workspaceId, stored.id) as { payload_json: string };
    expect(JSON.parse(communication.payload_json)).toMatchObject({
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionRevisionId: fixture.revisionId,
      sessionHandoff: stored.payload.sessionHandoff,
    });
    expect(receipt.communication?.status).toBe("PENDING");
  });

  it("replays the exact decision, session, speaker link, and communication without duplicates", () => {
    const fixture = setupFixture("replay");
    const input = {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED" as const,
    };
    const first = decideCfpSubmission(fixture.db, fixture.organizer, input);
    const counts = {
      proposalLineages: count(fixture.db, "proposal_lineages", "workspace_id = ?", fixture.workspaceId),
      programUnits: count(fixture.db, "program_units", "workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId),
      speakers: count(fixture.db, "event_speakers", "workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId),
      decisions: count(fixture.db, "domain_events", "workspace_id = ? AND event_type = 'cfp.submission.decision'", fixture.workspaceId),
      outbox: count(fixture.db, "outbox_messages"),
    };

    const replay = decideCfpSubmission(fixture.db, fixture.organizer, input);

    expect(replay.replayed).toBe(true);
    expect(replay.decisionEventId).toBe(first.decisionEventId);
    expect(replay.handoff?.linkedSession).toEqual(first.handoff?.linkedSession);
    expect({
      proposalLineages: count(fixture.db, "proposal_lineages", "workspace_id = ?", fixture.workspaceId),
      programUnits: count(fixture.db, "program_units", "workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId),
      speakers: count(fixture.db, "event_speakers", "workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId),
      decisions: count(fixture.db, "domain_events", "workspace_id = ? AND event_type = 'cfp.submission.decision'", fixture.workspaceId),
      outbox: count(fixture.db, "outbox_messages"),
    }).toEqual(counts);
    expect(() => decideCfpSubmission(fixture.db, fixture.organizer, { ...input, decision: "REJECTED" })).toThrowError(
      new CfpDecisionError("DECISION_ALREADY_RECORDED"),
    );
  });

  it("preserves an existing native lineage binding and its immutable display projection", () => {
    const fixture = setupFixture("existing-lineage");
    const displayProjection = {
      schema: "pd01-existing-proposal-memory/v1",
      label: "Organizer-preserved lineage display",
    };
    const lineage = createProposalLineage(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      submissionId: fixture.submissionId,
      submissionRevisionId: fixture.revisionId,
      displayProjection,
      idempotencyKey: "cfp-15-existing-lineage-create",
      expectedSubmissionCurrentRevisionId: fixture.revisionId,
    });
    bindSubmissionToLineage(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      submissionId: fixture.submissionId,
      lineageId: lineage.lineageId,
      expectedLineageId: null,
      idempotencyKey: "cfp-15-existing-lineage-bind",
      expectedCurrentRevisionId: fixture.revisionId,
    });
    const storedBefore = fixture.db.prepare(
      `SELECT id, originating_submission_id, originating_submission_revision_id,
              display_projection_json, created_by_account_id, created_at
         FROM proposal_lineages WHERE workspace_id = ? AND id = ?`,
    ).get(fixture.workspaceId, lineage.lineageId);

    const receipt = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    });

    expect(receipt.handoff?.linkedSession.proposalLineageId).toBe(lineage.lineageId);
    expect(count(fixture.db, "proposal_lineages", "workspace_id = ?", fixture.workspaceId)).toBe(1);
    expect(fixture.db.prepare(
      `SELECT id, originating_submission_id, originating_submission_revision_id,
              display_projection_json, created_by_account_id, created_at
         FROM proposal_lineages WHERE workspace_id = ? AND id = ?`,
    ).get(fixture.workspaceId, lineage.lineageId)).toEqual(storedBefore);
    expect(JSON.parse((storedBefore as { display_projection_json: string }).display_projection_json)).toEqual(displayProjection);
  });

  it("groups two accepted submissions in one shared lineage as one session with two exact speaker links", () => {
    const shared = {
      title: "One shared session",
      abstract: "Two presenters share one durable proposal lineage.",
      format: "Talk",
      track: "Trust",
      durationMinutes: 30,
    } as const;
    const fixture = setupFixture("shared-lineage", shared);
    const second = addSubmittedProposal(fixture, "shared-lineage-second", shared);
    const lineage = createProposalLineage(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      submissionId: fixture.submissionId,
      submissionRevisionId: fixture.revisionId,
      displayProjection: { schema: "cfp-15-shared-lineage/v1", title: shared.title },
      idempotencyKey: "cfp-15-shared-lineage-create",
      expectedSubmissionCurrentRevisionId: fixture.revisionId,
    });
    for (const submission of [
      { id: fixture.submissionId, revisionId: fixture.revisionId, expectedLineageId: null },
      { id: second.submissionId, revisionId: second.revisionId, expectedLineageId: null },
    ]) {
      bindSubmissionToLineage(fixture.db, fixture.organizer, {
        workspaceSlug: fixture.workspaceSlug,
        submissionId: submission.id,
        lineageId: lineage.lineageId,
        expectedLineageId: submission.expectedLineageId,
        idempotencyKey: `cfp-15-shared-bind-${submission.id}`,
        expectedCurrentRevisionId: submission.revisionId,
      });
    }
    const firstDecision = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    });
    const secondDecision = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: second.submissionId,
      expectedRevisionId: second.revisionId,
      decision: "ACCEPTED",
    });
    expect(secondDecision.handoff?.linkedSession.programUnitId)
      .toBe(firstDecision.handoff?.linkedSession.programUnitId);
    const inventory = readAcceptedCfpScheduleInventory(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    });
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      proposalLineageId: lineage.lineageId,
      programUnitName: shared.title,
      durationMinutes: 30,
      proposalTrack: "Trust",
    });
    expect(inventory[0]?.links.map((link) => link.speakerPersonId).sort()).toEqual(
      [fixture.applicantPersonId, second.personId].sort(),
    );
    expect(new Set(inventory[0]?.links.map((link) => link.linkFingerprint)).size).toBe(2);
    const programUnitId = firstDecision.handoff?.linkedSession.programUnitId;
    if (!programUnitId) throw new Error("expected shared program unit");
    installApprovedPlan(fixture, programUnitId);
    const schedule = readScheduleDraft(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }).schedule;
    expect(schedule.sessions).toHaveLength(1);
    expect(schedule.sessions[0]).toMatchObject({
      id: programUnitId,
      title: shared.title,
      speakerIds: expect.arrayContaining([fixture.applicantPersonId, second.personId]),
      placement: null,
    });
    expect(count(fixture.db, "program_units", "workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId)).toBe(1);
  });

  it("accepts only the exact current submitted amendment revision into scheduler inventory", () => {
    const fixture = setupFixture("amendment");
    const amended = amendSubmittedSubmission(fixture.db, {
      workspaceId: fixture.workspaceId,
      callId: fixture.callId,
      sessionTokenHash: fixture.sessionTokenHash,
      submissionId: fixture.submissionId,
      expectedCurrentRevisionId: fixture.revisionId,
      historicalAnswers: [
        { fieldId: "title", value: "Accepted amended title" },
        { fieldId: "abstract", value: "Only the current immutable amendment may become inventory." },
        { fieldId: "format", value: "Workshop" },
        { fieldId: "track", value: "Trust" },
        { fieldId: "durationMinutes", value: "25" },
        { fieldId: "consent", value: true },
      ],
    });
    expect(amended.revisionId).not.toBe(fixture.revisionId);
    const decision = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: amended.revisionId,
      decision: "ACCEPTED",
    });
    expect(decision).toMatchObject({
      submissionRevisionId: amended.revisionId,
      handoff: {
        title: "Accepted amended title",
        sourceRevisionId: amended.revisionId,
        linkedSession: { durationMinutes: 25 },
      },
    });
    const inventory = readAcceptedCfpScheduleInventory(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    });
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      programUnitName: "Accepted amended title",
      durationMinutes: 25,
      links: [{ sourceRevisionId: amended.revisionId }],
    });
    expect(inventory[0]?.links.some((link) => link.sourceRevisionId === fixture.revisionId)).toBe(false);
  });

  it("keeps distinct proposal lineages with the same display title as distinct scheduler sessions", () => {
    const fixture = setupFixture("duplicate-title", { title: "Same public title", track: "Trust" });
    const second = addSubmittedProposal(fixture, "duplicate-title-second", {
      title: "Same public title",
      track: "Trust",
    });
    const firstDecision = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    });
    const secondDecision = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: second.submissionId,
      expectedRevisionId: second.revisionId,
      decision: "ACCEPTED",
    });
    const firstProgramUnitId = firstDecision.handoff?.linkedSession.programUnitId;
    const secondProgramUnitId = secondDecision.handoff?.linkedSession.programUnitId;
    expect(firstProgramUnitId).not.toBe(secondProgramUnitId);
    if (!firstProgramUnitId || !secondProgramUnitId) throw new Error("expected two program units");
    const storedNames = fixture.db.prepare(
      `SELECT name FROM program_units WHERE workspace_id = ? AND event_id = ? ORDER BY name`,
    ).all(fixture.workspaceId, fixture.eventId) as Array<{ name: string }>;
    expect(new Set(storedNames.map((row) => row.name)).size).toBe(2);
    installApprovedPlan(fixture, firstProgramUnitId);
    const schedule = readScheduleDraft(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }).schedule;
    expect(schedule.sessions).toHaveLength(2);
    expect(schedule.sessions.map((session) => session.title)).toEqual([
      "Same public title",
      "Same public title",
    ]);
  });

  it("uses exact format duration and exact proposal track without whole-event or first-track substitution", () => {
    const fixture = setupFixture("exact-duration-track", {
      format: "Workshop",
      formatDurationMinutes: 30,
      track: "Trust",
    });
    fixture.db.prepare(
      `INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at)
       VALUES ('first-track-exact-duration', ?, ?, 'First unrelated track', 'first-unrelated-track', ?),
              ('proposal-track-exact-duration', ?, ?, 'Trust', 'trust-proposal-slug', ?)`,
    ).run(
      fixture.workspaceId,
      fixture.eventId,
      FIXTURE_AT,
      fixture.workspaceId,
      fixture.eventId,
      FIXTURE_AT,
    );
    const decision = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    });
    expect(decision.handoff?.linkedSession).toMatchObject({
      durationMinutes: 30,
      trackId: "proposal-track-exact-duration",
      trackName: "Trust",
      status: "UNSCHEDULED",
    });
    const programUnitId = decision.handoff?.linkedSession.programUnitId;
    const trackId = decision.handoff?.linkedSession.trackId;
    if (!programUnitId || !trackId) throw new Error("expected bounded handoff authority");
    expect(fixture.db.prepare(
      `SELECT starts_at, ends_at FROM program_units WHERE workspace_id = ? AND event_id = ? AND id = ?`,
    ).get(fixture.workspaceId, fixture.eventId, programUnitId)).toEqual({
      starts_at: EVENT_STARTS_AT,
      ends_at: "2026-09-18T09:30:00.000Z",
    });
    expect(fixture.db.prepare(
      `SELECT name FROM event_tracks WHERE workspace_id = ? AND event_id = ? AND id = ?`,
    ).get(fixture.workspaceId, fixture.eventId, trackId)).toEqual({ name: "Trust" });
    installApprovedPlan(fixture, programUnitId);
    const session = readScheduleDraft(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }).schedule.sessions.find((candidate) => candidate.id === programUnitId);
    expect(session).toMatchObject({ durationMinutes: 30, trackId, placement: null });
    expect(session?.trackId).not.toBe("first-track-exact-duration");
    const draft = readScheduleDraft(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }).schedule;
    const slot = draft.timeSlots.find((candidate) =>
      candidate.startsAt === EVENT_STARTS_AT && candidate.endsAt === "2026-09-18T09:30:00.000Z"
    );
    if (!slot) throw new Error("expected exact 30-minute scheduler slot");
    executeScheduleDraftCommand(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }, {
      expectedRevision: draft.revision,
      planVersionId: draft.planVersionId,
      planFingerprint: draft.planFingerprint,
      acceptedInventoryFingerprint: draft.acceptedInventoryFingerprint,
      cfpSessionInventoryFingerprint: draft.cfpSessionInventoryFingerprint,
      command: {
        kind: "MOVE",
        sessionId: programUnitId,
        target: {
          dayId: slot.dayId,
          timeSlotId: slot.id,
          roomId: draft.rooms[0]!.id,
          trackId,
        },
      },
      idempotencyKey: "exact-duration-track-placement",
      requestId: "exact-duration-track-placement-request",
      actorAccountId: fixture.organizer.accountId,
    });
    expect(fixture.db.prepare(
      `SELECT name, slug FROM event_tracks
        WHERE workspace_id = ? AND event_id = ? AND id = ?`,
    ).get(fixture.workspaceId, fixture.eventId, trackId)).toEqual({
      name: "Trust",
      slug: "trust-proposal-slug",
    });
  });

  it("projects legacy v1 accepted evidence into bounded scheduler inventory without inventing lineage or commitment", () => {
    const fixture = setupFixture("legacy-v1", { track: "Trust" });
    const current = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    });
    const programUnitId = current.handoff?.linkedSession.programUnitId;
    if (!programUnitId) throw new Error("expected source program unit");
    rewriteDecisionAsLegacyV1(fixture);
    const inventory = readAcceptedCfpScheduleInventory(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    });
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      authorityVersion: "LEGACY_V1",
      proposalLineageId: null,
      programUnitId,
      programUnitName: "Accepted proposal legacy-v1",
      startsAt: EVENT_STARTS_AT,
      endsAt: "2026-09-18T09:45:00.000Z",
      durationMinutes: 45,
      durationSource: "CANONICAL_DEFAULT",
      capacity: 1,
      proposalTrack: "Trust",
    });
    expect(fixture.db.prepare(
      `SELECT starts_at, ends_at, capacity FROM program_units
        WHERE workspace_id = ? AND event_id = ? AND id = ?`,
    ).get(fixture.workspaceId, fixture.eventId, programUnitId)).toEqual({
      starts_at: EVENT_STARTS_AT,
      ends_at: EVENT_ENDS_AT,
      capacity: 0,
    });
    installApprovedPlan(fixture, programUnitId);
    const schedule = readScheduleDraft(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }).schedule;
    expect(schedule.sessions).toEqual([
      expect.objectContaining({
        id: programUnitId,
        title: "Accepted proposal legacy-v1",
        durationMinutes: 45,
        capacity: 1,
        speakerIds: [fixture.applicantPersonId],
        placement: null,
      }),
    ]);
    expect(count(fixture.db, "commitment_responses", "workspace_id = ?", fixture.workspaceId)).toBe(0);
  });

  it("fails closed without handoff side effects when a required proposal track resolves ambiguously", () => {
    const fixture = setupFixture("ambiguous-track", { track: "Trust", trackRequired: true });
    fixture.db.prepare(
      `INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at)
       VALUES ('Trust', ?, ?, 'Track identified by id', 'track-by-id', ?),
              ('track-by-name', ?, ?, 'Trust', 'track-by-name', ?)`,
    ).run(
      fixture.workspaceId,
      fixture.eventId,
      FIXTURE_AT,
      fixture.workspaceId,
      fixture.eventId,
      FIXTURE_AT,
    );
    const before = {
      lineages: count(fixture.db, "proposal_lineages"),
      units: count(fixture.db, "program_units"),
      speakers: count(fixture.db, "event_speakers"),
      decisions: count(fixture.db, "domain_events", "event_type = 'cfp.submission.decision'"),
      outbox: count(fixture.db, "outbox_messages"),
    };
    expect(() => decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    })).toThrowError(new CfpDecisionError("DECISION_WRITE_FAILED"));
    expect({
      lineages: count(fixture.db, "proposal_lineages"),
      units: count(fixture.db, "program_units"),
      speakers: count(fixture.db, "event_speakers"),
      decisions: count(fixture.db, "domain_events", "event_type = 'cfp.submission.decision'"),
      outbox: count(fixture.db, "outbox_messages"),
    }).toEqual(before);
  });

  it("rejects without creating a program session or speaker linkage", () => {
    const fixture = setupFixture("rejected");
    const receipt = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "REJECTED",
    });

    expect(receipt.decision).toBe("REJECTED");
    expect(receipt.handoff).toBeNull();
    expect(count(fixture.db, "proposal_lineages", "workspace_id = ?", fixture.workspaceId)).toBe(0);
    expect(count(fixture.db, "program_units", "workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId)).toBe(0);
    expect(count(fixture.db, "event_speakers", "workspace_id = ? AND event_id = ?", fixture.workspaceId, fixture.eventId)).toBe(0);
    expect(count(fixture.db, "domain_events", "workspace_id = ? AND event_type = 'cfp.submission.decision'", fixture.workspaceId)).toBe(1);
  });

  it("rolls back the session, decision, speaker link, and outbox when communication cannot be queued", () => {
    const fixture = setupFixture("rollback");
    const before = {
      proposalLineages: count(fixture.db, "proposal_lineages"),
      lineageAudits: count(fixture.db, "audit_events", "action LIKE 'pd01.%'"),
      programUnits: count(fixture.db, "program_units"),
      speakers: count(fixture.db, "event_speakers"),
      decisions: count(fixture.db, "domain_events", "event_type = 'cfp.submission.decision'"),
      outbox: count(fixture.db, "outbox_messages"),
    };
    fixture.db.exec(
      `CREATE TRIGGER cfp_15_fail_decision_outbox
       BEFORE INSERT ON outbox_messages
       WHEN NEW.destination_key LIKE 'cfp:${fixture.submissionId}:%'
       BEGIN SELECT RAISE(ABORT, 'cfp-15-test-outbox-failure'); END;`,
    );

    expect(() => decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    })).toThrowError(new CfpDecisionError("DECISION_WRITE_FAILED"));
    expect({
      proposalLineages: count(fixture.db, "proposal_lineages"),
      lineageAudits: count(fixture.db, "audit_events", "action LIKE 'pd01.%'"),
      programUnits: count(fixture.db, "program_units"),
      speakers: count(fixture.db, "event_speakers"),
      decisions: count(fixture.db, "domain_events", "event_type = 'cfp.submission.decision'"),
      outbox: count(fixture.db, "outbox_messages"),
    }).toEqual(before);
    expect(fixture.db.prepare(
      "SELECT lineage_id FROM submissions WHERE workspace_id = ? AND id = ?",
    ).get(fixture.workspaceId, fixture.submissionId)).toEqual({ lineage_id: null });
  });

  it("fails closed for stale, wrong-event, and cross-tenant decision attempts without writes", () => {
    const fixture = setupFixture("scope");
    const baseline = {
      proposalLineages: count(fixture.db, "proposal_lineages"),
      programUnits: count(fixture.db, "program_units"),
      decisions: count(fixture.db, "domain_events", "event_type = 'cfp.submission.decision'"),
      outbox: count(fixture.db, "outbox_messages"),
    };
    const input = {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED" as const,
    };
    expect(() => decideCfpSubmission(fixture.db, fixture.organizer, { ...input, expectedRevisionId: "stale-revision" })).toThrowError(
      new CfpDecisionError("SUBMISSION_STALE"),
    );
    expect(() => decideCfpSubmission(fixture.db, fixture.organizer, { ...input, eventId: "another-event" })).toThrowError(
      new CfpDecisionError("SUBMISSION_NOT_AVAILABLE"),
    );
    const acme = fixture.db.prepare(
      "SELECT id FROM workspaces WHERE slug = 'acme'",
    ).get() as { id: string };
    const acmeOrganizer = fixture.db.prepare(
      "SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' LIMIT 1",
    ).get(acme.id) as { id: string };
    const acmeSession = createSession(fixture.db, acmeOrganizer.id, acme.id).session;
    expect(() => decideCfpSubmission(fixture.db, acmeSession, {
      ...input,
      workspaceSlug: "acme",
    })).toThrowError(new CfpDecisionError("SUBMISSION_NOT_AVAILABLE"));
    expect({
      proposalLineages: count(fixture.db, "proposal_lineages"),
      programUnits: count(fixture.db, "program_units"),
      decisions: count(fixture.db, "domain_events", "event_type = 'cfp.submission.decision'"),
      outbox: count(fixture.db, "outbox_messages"),
    }).toEqual(baseline);
  });

  it("projects exactly one unscheduled item, schedules it once, reloads, and shows coherent applicant placement", async () => {
    const fixture = setupFixture("scheduler");
    const receipt = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    });
    if (!receipt.handoff) throw new Error("expected an accepted CFP session handoff");
    const programUnitId = receipt.handoff.linkedSession.programUnitId;
    const assignmentId = "cfp-15-scheduler-assignment";
    const authority = installApprovedPlan(fixture, programUnitId, 1, null, [{
      assignmentId,
      personId: fixture.applicantPersonId,
      programUnitId,
      assignmentType: "SPEAKER",
      explanation: "Exact CFP session commitment authority.",
    }]);
    const otherEventId = "cfp-15-global-resource-owner";
    fixture.db.prepare(
      `INSERT INTO events
         (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, 'Existing resource owner', 'UTC', ?, ?, 'planning', ?)`,
    ).run(otherEventId, fixture.workspaceId, EVENT_STARTS_AT, EVENT_ENDS_AT, FIXTURE_AT);
    fixture.db.prepare(
      `INSERT INTO event_rooms (id, workspace_id, event_id, name, capacity, created_at)
       VALUES ('room-default', ?, ?, 'Existing global room id', 10, ?)`,
    ).run(fixture.workspaceId, otherEventId, FIXTURE_AT);
    fixture.db.prepare(
      `INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at)
       VALUES ('track-default', ?, ?, 'Existing global track id', 'existing-global-track', ?)`,
    ).run(fixture.workspaceId, otherEventId, FIXTURE_AT);

    expect(count(
      fixture.db,
      "commitment_responses",
      "workspace_id = ?",
      fixture.workspaceId,
    )).toBe(0);
    expect(fixture.db.prepare(
      `SELECT participation_status
         FROM event_speakers
        WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).get(fixture.workspaceId, fixture.eventId, fixture.applicantPersonId)).toEqual({
      participation_status: "INVITED",
    });

    const initial = readScheduleDraft(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    });
    expect(initial.persisted).toBe(false);
    expect(initial.schedule).toMatchObject({
      planVersionId: authority.planVersionId,
      planFingerprint: authority.planFingerprint,
      revision: 1,
    });
    expect(initial.schedule.sessions).toHaveLength(1);
    expect(initial.schedule.sessions[0]).toMatchObject({
      id: programUnitId,
      title: "Accepted proposal scheduler",
      capacity: 1,
      speakerIds: [fixture.applicantPersonId],
      placement: null,
    });
    const slot = initial.schedule.timeSlots.find((candidate) =>
      candidate.startsAt === EVENT_STARTS_AT && candidate.endsAt === EVENT_ENDS_AT
    );
    if (!slot) throw new Error("expected the canonical CFP session time slot");
    const input = {
      expectedRevision: initial.schedule.revision,
      planVersionId: initial.schedule.planVersionId,
      planFingerprint: initial.schedule.planFingerprint,
      acceptedInventoryFingerprint: initial.schedule.acceptedInventoryFingerprint,
      cfpSessionInventoryFingerprint: initial.schedule.cfpSessionInventoryFingerprint,
      command: {
        kind: "MOVE" as const,
        sessionId: programUnitId,
        target: {
          dayId: slot.dayId,
          timeSlotId: slot.id,
          roomId: initial.schedule.rooms[0]!.id,
          trackId: initial.schedule.tracks[0]!.id,
        },
      },
      idempotencyKey: "cfp-15-scheduler-move",
      requestId: "cfp-15-scheduler-move-request",
      actorAccountId: fixture.organizer.accountId,
    };
    const draftEventsBeforeDeniedCommands = count(
      fixture.db,
      "domain_events",
      "workspace_id = ? AND event_type = 'organizer.schedule_draft.saved' AND aggregate_id = ?",
      fixture.workspaceId,
      fixture.eventId,
    );
    const { cfpSessionInventoryFingerprint: _omittedFingerprint, ...missingCfpAuthority } = input;
    expect(() => executeScheduleDraftCommand(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }, missingCfpAuthority)).toThrowError(expect.objectContaining({ code: "SCHEDULE_INPUT_INVALID" }));
    expect(() => executeScheduleDraftCommand(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }, {
      ...input,
      cfpSessionInventoryFingerprint: "0".repeat(64),
      idempotencyKey: "cfp-15-scheduler-stale-inventory",
      requestId: "cfp-15-scheduler-stale-inventory-request",
    })).toThrowError(expect.objectContaining({ code: "SCHEDULE_CONTEXT_CONFLICT" }));
    expect(count(
      fixture.db,
      "domain_events",
      "workspace_id = ? AND event_type = 'organizer.schedule_draft.saved' AND aggregate_id = ?",
      fixture.workspaceId,
      fixture.eventId,
    )).toBe(draftEventsBeforeDeniedCommands);
    const moved = executeScheduleDraftCommand(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }, input);
    expect(moved.changed).toBe(true);
    expect(moved.schedule.sessions[0]?.placement).toMatchObject({
      startsAt: EVENT_STARTS_AT,
      endsAt: "2026-09-18T09:45:00.000Z",
    });
    expect(count(
      fixture.db,
      "event_session_allocations",
      "workspace_id = ? AND event_id = ? AND program_unit_id = ?",
      fixture.workspaceId,
      fixture.eventId,
      programUnitId,
    )).toBe(1);

    const replay = executeScheduleDraftCommand(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }, input);
    expect(replay.changed).toBe(false);
    expect(replay.pointer).toEqual(moved.pointer);
    expect(count(
      fixture.db,
      "event_session_allocations",
      "workspace_id = ? AND event_id = ? AND program_unit_id = ?",
      fixture.workspaceId,
      fixture.eventId,
      programUnitId,
    )).toBe(1);

    const reloaded = readScheduleDraft(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    });
    expect(reloaded.persisted).toBe(true);
    expect(reloaded.schedule.sessions).toHaveLength(1);
    expect(reloaded.schedule.sessions[0]?.placement).toEqual(moved.schedule.sessions[0]?.placement);
    expect(count(fixture.db, "commitment_responses", "workspace_id = ?", fixture.workspaceId)).toBe(0);

    const dashboard = readApplicantSubmissionDashboard(fixture.db, {
      workspaceId: fixture.workspaceId,
      callId: fixture.callId,
      sessionTokenHash: fixture.sessionTokenHash,
      submissionId: fixture.submissionId,
    });
    if (!dashboard?.decision?.handoff) throw new Error("expected draft applicant handoff");
    expect(dashboard.decision.handoff.linkedSession).toMatchObject({
      status: "DRAFT_UNPUBLISHED",
      placement: null,
      release: null,
    });
    const html = renderToStaticMarkup(await ApplicantDashboard({
      workspace: fixture.workspaceSlug,
      callSlug: "cfp-15-scheduler",
      call: {
        name: "CFP 15 scheduler",
        slug: "cfp-15-scheduler",
        accessMode: "PUBLIC",
        state: "OPEN",
        availability: "open",
        timezone: "UTC",
        opensAt: FIXTURE_AT,
        closesAt: EVENT_ENDS_AT,
        disclosure: {},
        choices: [],
        fields: [],
      },
      submission: dashboard,
      confirmation: null,
    }));
    expect(html).toContain("DRAFT_UNPUBLISHED");
    expect(html).toContain("draft, unpublished placement");
    expect(html).not.toContain("Main room");
    expect(html).not.toContain("Scheduled time");

    const scheduleEvidence = findScheduleDraftAuthorityEvidence(
      fixture.db,
      { workspaceId: fixture.workspaceId, eventId: fixture.eventId },
      moved.pointer,
    );
    if (!scheduleEvidence) throw new Error("expected exact schedule audit evidence");
    const historicalBeforeTransition = readCanonicalScheduleAuthorityAt(
      fixture.db,
      { workspaceId: fixture.workspaceId, eventId: fixture.eventId },
      { auditEventId: scheduleEvidence.auditEventId, at: scheduleEvidence.recordedAt },
    );
    expect(historicalBeforeTransition).toMatchObject({
      planVersionId: authority.planVersionId,
      cfpSessionInventoryFingerprint: moved.schedule.cfpSessionInventoryFingerprint,
    });
    persistAndApproveCurrentSchedule(
      fixture.db,
      { workspaceId: fixture.workspaceId, eventId: fixture.eventId },
      fixture.organizer.accountId,
      "cfp-15-scheduler-cfp-only",
    );

    const cfpOnlyReleaseState = {
      count: count(
        fixture.db,
        "publication_releases",
        "workspace_id = ? AND event_id = ?",
        fixture.workspaceId,
        fixture.eventId,
      ),
      currentReleaseId: (fixture.db.prepare(
        "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(fixture.workspaceId, fixture.eventId) as { currentReleaseId: string | null }).currentReleaseId,
    };
    expect(() => sealRelease(fixture.db, fixture.workspaceId, fixture.eventId, {
      kind: "account",
      ref: fixture.organizer.accountId,
    })).toThrow("SESSION_CONTENT_REQUIREMENTS_INCOMPLETE");
    expect({
      count: count(
        fixture.db,
        "publication_releases",
        "workspace_id = ? AND event_id = ?",
        fixture.workspaceId,
        fixture.eventId,
      ),
      currentReleaseId: (fixture.db.prepare(
        "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(fixture.workspaceId, fixture.eventId) as { currentReleaseId: string | null }).currentReleaseId,
    }).toEqual(cfpOnlyReleaseState);

    deliverOffers(fixture.db, fixture.workspaceId, fixture.eventId, {
      kind: "account",
      ref: fixture.organizer.accountId,
    });
    const offer = fixture.db.prepare(
      `SELECT id FROM commitment_offers
        WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ? AND person_id = ?`,
    ).get(
      fixture.workspaceId,
      fixture.eventId,
      authority.planVersionId,
      fixture.applicantPersonId,
    ) as { id: string };
    respondToOfferCommand(fixture.db, fixture.workspaceId, fixture.eventId, {
      offerId: offer.id,
      response: "accepted",
      commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
    });
    expect(fixture.db.prepare(
      `UPDATE event_speakers
          SET participation_status = 'CONFIRMED'
        WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND role_key = 'SPEAKER'`,
    ).run(fixture.workspaceId, fixture.eventId, fixture.applicantPersonId).changes).toBe(1);
    const approved = approveExactSessionContent(
      fixture,
      fixture.applicantPersonId,
      "scheduler-authority",
      {
        title: "Approved scheduler title",
        description: "Approved scheduler abstract",
      },
    );
    const commitmentBackedDraft = readScheduleDraft(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    });
    const commitmentBackedSession = commitmentBackedDraft.schedule.sessions.find((session) => session.id === programUnitId);
    if (!commitmentBackedSession?.placement) throw new Error("expected the durable CFP placement to survive commitment acceptance");
    const commitmentSchedule = executeScheduleDraftCommand(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }, {
      expectedRevision: commitmentBackedDraft.schedule.revision,
      planVersionId: commitmentBackedDraft.schedule.planVersionId,
      planFingerprint: commitmentBackedDraft.schedule.planFingerprint,
      acceptedInventoryFingerprint: commitmentBackedDraft.schedule.acceptedInventoryFingerprint,
      cfpSessionInventoryFingerprint: commitmentBackedDraft.schedule.cfpSessionInventoryFingerprint,
      command: {
        kind: "MOVE",
        sessionId: programUnitId,
        target: {
          dayId: commitmentBackedSession.placement.dayId,
          timeSlotId: commitmentBackedSession.placement.timeSlotId,
          roomId: commitmentBackedSession.placement.roomId,
          trackId: commitmentBackedSession.placement.trackId,
        },
      },
      idempotencyKey: "cfp-15-scheduler-commitment-authority",
      requestId: "cfp-15-scheduler-commitment-authority-request",
      actorAccountId: fixture.organizer.accountId,
    });
    const commitmentScheduleEvidence = findScheduleDraftAuthorityEvidence(
      fixture.db,
      { workspaceId: fixture.workspaceId, eventId: fixture.eventId },
      commitmentSchedule.pointer,
    );
    if (!commitmentScheduleEvidence) throw new Error("expected commitment-backed schedule authority evidence");
    persistAndApproveCurrentSchedule(
      fixture.db,
      { workspaceId: fixture.workspaceId, eventId: fixture.eventId },
      fixture.organizer.accountId,
      "cfp-15-scheduler-commitment",
    );
    const release = sealRelease(fixture.db, fixture.workspaceId, fixture.eventId, {
      kind: "account",
      ref: fixture.organizer.accountId,
    });
    expect(release).toMatchObject({ created: true, agendaCount: 1, tokenCount: 1 });
    const sealed = validatePublicReleaseForRead(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
      releaseId: release.releaseId,
      mode: "CURRENT",
    });
    expect(sealed?.content).toMatchObject({
      lineage: { releaseNumber: 1, supersedesReleaseId: null },
      accepted: [{ personId: fixture.applicantPersonId, programUnitId }],
      schedule: {
        sourceScheduleAuditId: commitmentScheduleEvidence.auditEventId,
        sourceSchedulePointerFingerprint: commitmentScheduleEvidence.pointerFingerprint,
        cfpSessionInventoryFingerprint: moved.schedule.cfpSessionInventoryFingerprint,
        sessions: [{
          programUnitId,
          title: "Approved scheduler title",
          abstract: "Approved scheduler abstract",
          titleVersionId: approved.title.id,
          titleContentHash: approved.title.contentHash,
          abstractVersionId: approved.description.id,
          abstractContentHash: approved.description.contentHash,
          speakerPersonIds: [fixture.applicantPersonId],
          placement: { roomName: "Main room", trackName: "Trust" },
        }],
      },
    });
    const releasedDashboard = readApplicantSubmissionDashboard(fixture.db, {
      workspaceId: fixture.workspaceId,
      callId: fixture.callId,
      sessionTokenHash: fixture.sessionTokenHash,
      submissionId: fixture.submissionId,
    });
    expect(releasedDashboard?.decision?.handoff?.linkedSession).toMatchObject({
      status: "RELEASED",
      placement: {
        roomName: "Main room",
        trackName: "Trust",
        startsAt: EVENT_STARTS_AT,
        endsAt: "2026-09-18T09:45:00.000Z",
      },
      release: { releaseNumber: 1 },
    });
    expect(readCurrentReleasedCfpSession(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
      programUnitId,
      speakerPersonId: "another-person",
    })).toBeNull();

    const acme = fixture.db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { id: string };
    expect(readCurrentReleasedCfpSession(fixture.db, {
      workspaceId: acme.id,
      eventId: fixture.eventId,
      programUnitId,
      speakerPersonId: fixture.applicantPersonId,
    })).toBeNull();
    expect(() => readScheduleDraft(fixture.db, {
      workspaceId: acme.id,
      eventId: fixture.eventId,
    })).toThrowError(expect.objectContaining({ code: "SCHEDULE_SCOPE_DENIED" }));

    approved.speaker.submitOrganizerContent(approved.organizerScope, {
      personId: fixture.applicantPersonId,
      taskId: approved.titleTask.id,
      payload: { kind: "SESSION_TITLE", title: "Unapproved scheduler replacement" },
      idempotencyKey: "cfp-15-scheduler-authority-title-replacement",
    });
    const releaseStateBeforeStaleReplacement = {
      count: count(
        fixture.db,
        "publication_releases",
        "workspace_id = ? AND event_id = ?",
        fixture.workspaceId,
        fixture.eventId,
      ),
      currentReleaseId: (fixture.db.prepare(
        "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(fixture.workspaceId, fixture.eventId) as { currentReleaseId: string | null }).currentReleaseId,
    };
    expect(() => sealRelease(fixture.db, fixture.workspaceId, fixture.eventId, {
      kind: "account",
      ref: fixture.organizer.accountId,
    })).toThrow("SESSION_CONTENT_NOT_APPROVED");
    expect({
      count: count(
        fixture.db,
        "publication_releases",
        "workspace_id = ? AND event_id = ?",
        fixture.workspaceId,
        fixture.eventId,
      ),
      currentReleaseId: (fixture.db.prepare(
        "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(fixture.workspaceId, fixture.eventId) as { currentReleaseId: string | null }).currentReleaseId,
    }).toEqual(releaseStateBeforeStaleReplacement);

    installApprovedPlan(fixture, programUnitId, 2, authority.planVersionId);
    expect(readCanonicalScheduleAuthorityAt(
      fixture.db,
      { workspaceId: fixture.workspaceId, eventId: fixture.eventId },
      { auditEventId: scheduleEvidence.auditEventId, at: scheduleEvidence.recordedAt },
    )).toEqual(historicalBeforeTransition);
    expect(validatePublicReleaseForRead(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
      releaseId: release.releaseId,
      mode: "CURRENT",
    })).toBeNull();
    expect(validatePublicReleaseForRead(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
      releaseId: release.releaseId,
      mode: "HISTORICAL",
    })?.releaseId).toBe(release.releaseId);
    const releaseStateBeforeDeniedReseal = {
      count: count(
        fixture.db,
        "publication_releases",
        "workspace_id = ? AND event_id = ?",
        fixture.workspaceId,
        fixture.eventId,
      ),
      currentReleaseId: (fixture.db.prepare(
        "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(fixture.workspaceId, fixture.eventId) as { currentReleaseId: string | null }).currentReleaseId,
    };
    expect(() => sealRelease(fixture.db, fixture.workspaceId, fixture.eventId, {
      kind: "account",
      ref: fixture.organizer.accountId,
    })).toThrow();
    expect({
      count: count(
        fixture.db,
        "publication_releases",
        "workspace_id = ? AND event_id = ?",
        fixture.workspaceId,
        fixture.eventId,
      ),
      currentReleaseId: (fixture.db.prepare(
        "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(fixture.workspaceId, fixture.eventId) as { currentReleaseId: string | null }).currentReleaseId,
    }).toEqual(releaseStateBeforeDeniedReseal);
  });

  it("rebases a saved draft only for a monotonic accepted-CFP addition", () => {
    const fixture = setupFixture("inventory-addition");
    const firstDecision = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    });
    if (!firstDecision.handoff) throw new Error("expected the first accepted CFP session");
    installApprovedPlan(fixture, firstDecision.handoff.linkedSession.programUnitId);
    const initial = readScheduleDraft(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    });
    const firstSession = initial.schedule.sessions[0];
    const slot = initial.schedule.timeSlots[0];
    if (!firstSession || !slot) throw new Error("expected the first scheduler item and slot");
    const firstMoveInput = {
      expectedRevision: initial.schedule.revision,
      planVersionId: initial.schedule.planVersionId,
      planFingerprint: initial.schedule.planFingerprint,
      acceptedInventoryFingerprint: initial.schedule.acceptedInventoryFingerprint,
      cfpSessionInventoryFingerprint: initial.schedule.cfpSessionInventoryFingerprint,
      command: {
        kind: "MOVE" as const,
        sessionId: firstSession.id,
        target: {
          dayId: slot.dayId,
          timeSlotId: slot.id,
          roomId: initial.schedule.rooms[0]!.id,
          trackId: initial.schedule.tracks[0]!.id,
        },
      },
      idempotencyKey: "cfp-15-first-inventory-move",
      requestId: "cfp-15-first-inventory-move-request",
      actorAccountId: fixture.organizer.accountId,
    };
    const saved = executeScheduleDraftCommand(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }, firstMoveInput);
    const second = addSubmittedProposal(fixture, "inventory-addition-second");
    const secondDecision = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: second.submissionId,
      expectedRevisionId: second.revisionId,
      decision: "ACCEPTED",
    });
    if (!secondDecision.handoff) throw new Error("expected the second accepted CFP session");

    const rebased = readScheduleDraft(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    });
    expect(rebased.persisted).toBe(true);
    expect(rebased.schedule.sessions).toHaveLength(2);
    expect(rebased.schedule.cfpSessionInventoryFingerprint).not.toBe(initial.schedule.cfpSessionInventoryFingerprint);
    expect(rebased.schedule.sessions.find((session) => session.id === firstSession.id)?.placement)
      .toEqual(saved.schedule.sessions.find((session) => session.id === firstSession.id)?.placement);
    expect(rebased.schedule.sessions.find(
      (session) => session.id === secondDecision.handoff?.linkedSession.programUnitId,
    )).toMatchObject({
      title: second.title,
      speakerIds: [second.personId],
      placement: null,
    });
    const oldKeyReplay = executeScheduleDraftCommand(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }, firstMoveInput);
    expect(oldKeyReplay.changed).toBe(false);
    expect(oldKeyReplay.schedule.sessions).toHaveLength(2);
    expect(() => executeScheduleDraftCommand(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
    }, {
      ...firstMoveInput,
      command: { ...firstMoveInput.command, reason: "conflicting old-key retry" },
    })).toThrowError(expect.objectContaining({ code: "SCHEDULE_IDEMPOTENCY_CONFLICT" }));
    expect(count(
      fixture.db,
      "event_session_allocations",
      "workspace_id = ? AND event_id = ?",
      fixture.workspaceId,
      fixture.eventId,
    )).toBe(1);
  });

  it("seals the exact mixed commitment and CFP scheduler inventory", () => {
    const fixture = setupFixture("mixed-seal");
    const decision = decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    });
    const cfpUnitId = decision.handoff?.linkedSession.programUnitId;
    if (!cfpUnitId) throw new Error("expected mixed CFP unit");
    const commitmentPerson = addSubmittedProposal(fixture, "mixed-commitment-person");
    const commitmentUnitId = "cfp-15-mixed-commitment-unit";
    const cfpAssignmentId = "cfp-15-mixed-cfp-assignment";
    const assignmentId = "cfp-15-mixed-assignment";
    fixture.db.prepare(
      `INSERT INTO program_units
         (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
       VALUES (?, ?, ?, 'Committed mixed session', 'session',
               '2026-09-18T10:00:00.000Z', '2026-09-18T10:45:00.000Z', 25, ?)`,
    ).run(commitmentUnitId, fixture.workspaceId, fixture.eventId, FIXTURE_AT);
    const authority = installApprovedPlan(fixture, cfpUnitId, 1, null, [
      {
        assignmentId: cfpAssignmentId,
        personId: fixture.applicantPersonId,
        programUnitId: cfpUnitId,
        assignmentType: "SPEAKER",
        explanation: "Exact mixed-inventory CFP commitment authority.",
      },
      {
        assignmentId,
        personId: commitmentPerson.personId,
        programUnitId: commitmentUnitId,
        assignmentType: "SPEAKER",
        explanation: "Exact mixed-inventory commitment authority.",
      },
    ]);
    deliverOffers(fixture.db, fixture.workspaceId, fixture.eventId, {
      kind: "account",
      ref: fixture.organizer.accountId,
    });
    const offer = fixture.db.prepare(
      `SELECT id FROM commitment_offers
        WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ? AND person_id = ?`,
    ).get(fixture.workspaceId, fixture.eventId, authority.planVersionId, commitmentPerson.personId) as { id: string };
    respondToOfferCommand(fixture.db, fixture.workspaceId, fixture.eventId, {
      offerId: offer.id,
      response: "accepted",
      commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
    });
    const cfpOffer = fixture.db.prepare(
      `SELECT id FROM commitment_offers
        WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ? AND person_id = ?`,
    ).get(fixture.workspaceId, fixture.eventId, authority.planVersionId, fixture.applicantPersonId) as { id: string };
    respondToOfferCommand(fixture.db, fixture.workspaceId, fixture.eventId, {
      offerId: cfpOffer.id,
      response: "accepted",
      commandKey: commitmentResponseCommandKey(cfpOffer.id, "accepted"),
    });
    expect(fixture.db.prepare(
      `UPDATE event_speakers
          SET participation_status = 'CONFIRMED'
        WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND role_key = 'SPEAKER'`,
    ).run(fixture.workspaceId, fixture.eventId, fixture.applicantPersonId).changes).toBe(1);
    fixture.db.prepare(
      `INSERT INTO event_speakers
         (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
       VALUES ('cfp-15-mixed-speaker', ?, ?, ?, 'SPEAKER', 'CONFIRMED', ?, ?)`,
    ).run(fixture.workspaceId, fixture.eventId, commitmentPerson.personId, FIXTURE_AT, FIXTURE_AT);

    const cfpContent = approveExactSessionContent(fixture, fixture.applicantPersonId, "mixed-cfp", {
      title: "Approved mixed CFP title",
      description: "Approved mixed CFP abstract",
    });
    const committedContent = approveExactSessionContent(fixture, commitmentPerson.personId, "mixed-commitment", {
      title: "Approved committed title",
      description: "Approved committed abstract",
    });

    const scope = { workspaceId: fixture.workspaceId, eventId: fixture.eventId } as const;
    const expectedDraftSessionOrder = [cfpUnitId, commitmentUnitId];
    const expectedSealedSessionOrder = [...expectedDraftSessionOrder].sort();
    let draft = readScheduleDraft(fixture.db, scope);
    expect(draft.schedule.sessions.map((session) => session.id)).toEqual(expectedDraftSessionOrder);
    for (const sessionId of [cfpUnitId, commitmentUnitId]) {
      const session = draft.schedule.sessions.find((candidate) => candidate.id === sessionId)!;
      const expectedStart = sessionId === cfpUnitId ? EVENT_STARTS_AT : "2026-09-18T10:00:00.000Z";
      const slot = draft.schedule.timeSlots.find((candidate) => candidate.startsAt === expectedStart);
      if (!slot) throw new Error(`expected exact mixed slot for ${sessionId}`);
      executeScheduleDraftCommand(fixture.db, scope, {
        expectedRevision: draft.schedule.revision,
        planVersionId: draft.schedule.planVersionId,
        planFingerprint: draft.schedule.planFingerprint,
        acceptedInventoryFingerprint: draft.schedule.acceptedInventoryFingerprint,
        cfpSessionInventoryFingerprint: draft.schedule.cfpSessionInventoryFingerprint,
        command: {
          kind: "MOVE",
          sessionId,
          target: {
            dayId: slot.dayId,
            timeSlotId: slot.id,
            roomId: draft.schedule.rooms[0]!.id,
            trackId: session.trackId,
          },
        },
        idempotencyKey: `cfp-15-mixed-move-${sessionId}`,
        requestId: `cfp-15-mixed-move-request-${sessionId}`,
        actorAccountId: fixture.organizer.accountId,
      });
      draft = readScheduleDraft(fixture.db, scope);
    }
    persistAndApproveCurrentSchedule(
      fixture.db,
      scope,
      fixture.organizer.accountId,
      "cfp-15-mixed-schedule",
    );
    const release = sealRelease(fixture.db, fixture.workspaceId, fixture.eventId, {
      kind: "account",
      ref: fixture.organizer.accountId,
    });
    const sealed = validatePublicReleaseForRead(fixture.db, {
      workspaceId: fixture.workspaceId,
      eventId: fixture.eventId,
      releaseId: release.releaseId,
      mode: "CURRENT",
    });
    expect(sealed?.content.accepted).toHaveLength(2);
    expect(sealed?.content.schedule?.sessions.map((session) => session.programUnitId))
      .toEqual(expectedSealedSessionOrder);
    expect(sealed?.content.schedule?.sessions.find((session) => session.programUnitId === cfpUnitId))
      .toMatchObject({
        title: "Approved mixed CFP title",
        abstract: "Approved mixed CFP abstract",
        titleVersionId: cfpContent.title.id,
        titleContentHash: cfpContent.title.contentHash,
        abstractVersionId: cfpContent.description.id,
        abstractContentHash: cfpContent.description.contentHash,
      });
    expect(sealed?.content.schedule?.sessions.find((session) => session.programUnitId === commitmentUnitId))
      .toMatchObject({
        title: "Approved committed title",
        abstract: "Approved committed abstract",
        titleVersionId: committedContent.title.id,
        titleContentHash: committedContent.title.contentHash,
        abstractVersionId: committedContent.description.id,
        abstractContentHash: committedContent.description.contentHash,
      });
  });

  it("projects the linked session identifier and unscheduled status to the applicant", async () => {
    const fixture = setupFixture("projection");
    decideCfpSubmission(fixture.db, fixture.organizer, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
      callId: fixture.callId,
      submissionId: fixture.submissionId,
      expectedRevisionId: fixture.revisionId,
      decision: "ACCEPTED",
    });
    const dashboard = readApplicantSubmissionDashboard(fixture.db, {
      workspaceId: fixture.workspaceId,
      callId: fixture.callId,
      sessionTokenHash: fixture.sessionTokenHash,
      submissionId: fixture.submissionId,
    });
    if (!dashboard || !dashboard.decision?.handoff) throw new Error("expected accepted applicant projection");
    const call = {
      name: "CFP 15 projection",
      slug: "cfp-15-projection",
      accessMode: "PUBLIC" as const,
      state: "OPEN" as const,
      availability: "open" as const,
      timezone: "UTC",
      opensAt: FIXTURE_AT,
      closesAt: EVENT_ENDS_AT,
      disclosure: {},
      choices: [],
      fields: [],
    };
    const html = renderToStaticMarkup(await ApplicantDashboard({
      workspace: fixture.workspaceSlug,
      callSlug: call.slug,
      call,
      submission: dashboard,
      confirmation: null,
    }));
    expect(html).toContain("Linked program session");
    expect(html).toContain(dashboard.decision.handoff.linkedSession.programUnitId);
    expect(html).toContain("UNSCHEDULED");
    expect(html).toContain("no room or time slot yet");
  });
});
