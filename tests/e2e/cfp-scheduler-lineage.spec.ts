import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  sessionCookieName,
  submissionCookieName,
} from "../../src/app/cfp/cookie-scope.server";
import { createSession, SESSION_COOKIE } from "../../src/server/auth";
import { canonicalJson, fingerprintOf, sha256Hex } from "../../src/server/canonical";
import { closeDb, openDb } from "../../src/server/db";
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
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import {
  createCall,
  createFormDefinition,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { approvePlan } from "../../src/server/services/planning";

const DATABASE_PATH = resolve(process.env.SYMPOSE_DB_PATH ?? ".tmp/e2e/sympose.db");
const ORIGIN = process.env.CFP_SCHEDULER_E2E_ORIGIN ?? "http://127.0.0.1:3100";
const WORKSPACE_SLUG = "northstar";
const CREATED_AT = "2026-08-13T10:00:00.000Z";
const EVENT_STARTS_AT = "2026-09-21T09:00:00.000Z";
const EVENT_ENDS_AT = "2026-09-21T10:00:00.000Z";
const ACCESS_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

interface BrowserFixture {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly callId: string;
  readonly callSlug: string;
  readonly submissionId: string;
  readonly revisionId: string;
  readonly applicantPersonId: string;
  readonly applicantSessionToken: string;
  readonly applicantSessionTokenHash: string;
  readonly applicantName: string;
  readonly title: string;
  readonly organizerToken: string;
}

interface AcceptedBrowserAuthority {
  readonly proposalLineageId: string;
  readonly programUnitId: string;
}

interface BrowserHealth {
  readonly serverErrors: string[];
  readonly pageErrors: string[];
}

function monitorBrowserHealth(page: Page): BrowserHealth {
  const health: BrowserHealth = { serverErrors: [], pageErrors: [] };
  page.on("response", (response) => {
    if (response.status() >= 500) {
      health.serverErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on("pageerror", (error) => health.pageErrors.push(error.message));
  return health;
}

function createBrowserFixture(): BrowserFixture {
  const db = openDb({ path: DATABASE_PATH });
  try {
    const suffix = randomUUID();
    const workspace = db.prepare(
      "SELECT id FROM workspaces WHERE slug = ?",
    ).get(WORKSPACE_SLUG) as { id: string };
    const organizer = db.prepare(
      "SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' ORDER BY id LIMIT 1",
    ).get(workspace.id) as { id: string };
    const organizerSession = createSession(db, organizer.id, workspace.id);
    const eventId = randomUUID();
    db.prepare(
      `INSERT INTO events
         (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
    ).run(
      eventId,
      workspace.id,
      "CFP scheduler lineage browser proof",
      EVENT_STARTS_AT,
      EVENT_ENDS_AT,
      CREATED_AT,
    );

    const definition = createFormDefinition(db, organizerSession.session, {
      name: `CFP scheduler proof ${suffix}`,
    });
    const form = sealFormVersion(db, organizerSession.session, {
      formDefinitionId: definition.id,
      fields: [
        { id: "title", type: "shortText", label: "Proposal title", required: true, defaultVisibility: "visible" },
        { id: "abstract", type: "longText", label: "Proposal abstract", required: true, defaultVisibility: "visible" },
        { id: "format", type: "shortText", label: "Session format", required: false, defaultVisibility: "visible" },
        { id: "track", type: "shortText", label: "Track", required: false, defaultVisibility: "visible" },
        { id: "consent", type: "consent", label: "Accept terms", required: true, defaultVisibility: "visible" },
      ],
      rules: { schema: FORM_RULES_SCHEMA, rules: [] },
    });
    const callSlug = `cfp-scheduler-proof-${suffix}`;
    const call = createCall(db, organizerSession.session, {
      eventId,
      name: `CFP scheduler proof call ${suffix}`,
      slug: callSlug,
      formVersionId: form.id,
      policy: {
        disclosure: {
          privacy: "Organizer-only synthetic browser proof.",
          retention: "Synthetic test data only.",
          aiProcessing: "No AI processing.",
          communication: "Synthetic application status only.",
          consent: "Required synthetic terms are recorded.",
          publication: "No publication is performed by this proof.",
        },
        choices: [{ fieldId: "consent", statement: "Accept synthetic terms", required: true }],
      },
      accessMode: "PUBLIC",
      state: "OPEN",
      timezone: "UTC",
      opensAt: CREATED_AT,
      closesAt: ACCESS_EXPIRES_AT,
    });

    const verificationTokenHash = fingerprintOf({ suffix, kind: "cfp-scheduler-verification" });
    const applicantEmail = `cfp-scheduler-${suffix}@example.test`;
    const verification = issueEmailVerification(db, { workspaceId: workspace.id }, {
      callId: call.id,
      email: applicantEmail,
      tokenHash: verificationTokenHash,
    });
    const applicantSessionToken = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    const applicantSessionTokenHash = sha256Hex(applicantSessionToken);
    const applicantName = `Lineage Speaker ${suffix.slice(0, 8)}`;
    const applicant = consumeEmailVerification(db, { workspaceId: workspace.id }, {
      callId: call.id,
      verificationId: verification.verificationId,
      verificationTokenHash,
      applicantSessionTokenHash,
      fullName: applicantName,
    });
    const draft = createApplicantSubmissionDraft(db, {
      workspaceId: workspace.id,
      callId: call.id,
      sessionTokenHash: applicantSessionTokenHash,
    });
    const title = `Accepted lineage session ${suffix.slice(0, 8)}`;
    const answers = [
      { fieldId: "title", value: title },
      { fieldId: "abstract", value: "An exactly accepted revision enters scheduler inventory without a commitment response." },
      { fieldId: "format", value: "Workshop" },
      { fieldId: "track", value: "Trust" },
      { fieldId: "consent", value: true },
    ] as const;
    const saved = saveApplicantSubmissionDraft(db, {
      workspaceId: workspace.id,
      callId: call.id,
      sessionTokenHash: applicantSessionTokenHash,
      submissionId: draft.submissionId,
      historicalAnswers: answers,
      expectedCurrentRevisionId: null,
    });
    const submitted = submitApplicantSubmission(db, {
      workspaceId: workspace.id,
      callId: call.id,
      sessionTokenHash: applicantSessionTokenHash,
      submissionId: draft.submissionId,
      historicalAnswers: answers,
      expectedCurrentRevisionId: saved.revisionId,
    });
    const runId = randomUUID();
    const planVersionId = randomUUID();
    const planInput = {
      schema: "cfp-scheduler-browser-authority-input/v1",
      eventId,
      programUnitIds: [],
    };
    const planInputFingerprint = fingerprintOf(planInput);
    const planContent = {
      schema: "plan-version/v1",
      eventId,
      eventName: "CFP scheduler lineage browser proof",
      timezone: "UTC",
      startsAt: EVENT_STARTS_AT,
      endsAt: EVENT_ENDS_AT,
      runId,
      inputFingerprint: planInputFingerprint,
      snapshotFingerprint: fingerprintOf({
        schema: "cfp-scheduler-browser-empty-plan-snapshot/v1",
        eventId,
        versionNumber: 1,
      }),
      versionNumber: 1,
      assignments: [],
      exclusions: [],
      diagnostics: { messages: [], unitCounts: {}, moderatorsWithoutUnit: [] },
    };
    db.prepare(
      `INSERT INTO plan_runs
         (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json,
          compiler, compiler_version, created_at)
       VALUES (?, ?, ?, 'FEASIBLE', ?, ?, 'cfp-scheduler-browser-proof', '1', ?)`,
    ).run(
      runId,
      workspace.id,
      eventId,
      planInputFingerprint,
      canonicalJson(planInput),
      CREATED_AT,
    );
    db.prepare(
      `INSERT INTO plan_versions
         (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      planVersionId,
      workspace.id,
      eventId,
      runId,
      fingerprintOf(planContent),
      canonicalJson(planContent),
      CREATED_AT,
    );
    db.prepare(
      `INSERT INTO plan_states
         (id, workspace_id, plan_version_id, state, actor_account_id, reason, created_at)
       VALUES (?, ?, ?, 'candidate', ?, NULL, ?)`,
    ).run(randomUUID(), workspace.id, planVersionId, organizer.id, CREATED_AT);
    approvePlan(
      db,
      workspace.id,
      eventId,
      planVersionId,
      null,
      { kind: "account", ref: organizer.id },
    );

    return {
      workspaceId: workspace.id,
      eventId,
      callId: call.id,
      callSlug,
      submissionId: draft.submissionId,
      revisionId: submitted.revisionId,
      applicantPersonId: applicant.personId,
      applicantSessionToken,
      applicantSessionTokenHash,
      applicantName,
      title,
      organizerToken: organizerSession.token,
    };
  } finally {
    closeDb(db);
  }
}

function readAcceptedBrowserAuthority(fixture: BrowserFixture): AcceptedBrowserAuthority {
  const db = openDb({ path: DATABASE_PATH });
  try {
    const row = db.prepare(
      `SELECT payload_json
         FROM domain_events
        WHERE workspace_id = ? AND event_type = 'cfp.submission.decision'
          AND aggregate_type = 'cfp_submission' AND aggregate_id = ?
        ORDER BY rowid DESC LIMIT 1`,
    ).get(fixture.workspaceId, fixture.submissionId) as { payload_json: string } | undefined;
    if (!row) throw new Error("browser acceptance did not persist decision authority");
    const payload = JSON.parse(row.payload_json) as {
      sessionHandoff?: { proposalLineageId?: unknown; programUnitId?: unknown };
    };
    const proposalLineageId = payload.sessionHandoff?.proposalLineageId;
    const programUnitId = payload.sessionHandoff?.programUnitId;
    if (typeof proposalLineageId !== "string" || typeof programUnitId !== "string") {
      throw new Error("browser acceptance persisted malformed handoff authority");
    }
    return { proposalLineageId, programUnitId };
  } finally {
    closeDb(db);
  }
}

function readDurableProof(fixture: BrowserFixture, authority: AcceptedBrowserAuthority): {
  readonly allocationCount: number;
  readonly acceptedCommitmentResponseCount: number;
  readonly participationStatus: string;
  readonly lineageOriginRevisionId: string;
  readonly applicantSessionStatus: string | null;
} {
  const db = openDb({ path: DATABASE_PATH });
  try {
    const allocation = db.prepare(
      `SELECT COUNT(*) AS count
         FROM event_session_allocations
        WHERE workspace_id = ? AND event_id = ? AND program_unit_id = ?
          AND allocation_status <> 'CANCELLED'`,
    ).get(fixture.workspaceId, fixture.eventId, authority.programUnitId) as { count: number };
    const commitments = db.prepare(
      `SELECT COUNT(*) AS count
         FROM commitment_responses response
         JOIN commitment_offers offer
           ON offer.workspace_id = response.workspace_id
          AND offer.id = response.offer_id
        WHERE response.workspace_id = ? AND offer.event_id = ? AND response.response = 'accepted'`,
    ).get(fixture.workspaceId, fixture.eventId) as { count: number };
    const speaker = db.prepare(
      `SELECT participation_status
         FROM event_speakers
        WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).get(fixture.workspaceId, fixture.eventId, fixture.applicantPersonId) as { participation_status: string };
    const lineage = db.prepare(
      `SELECT originating_submission_revision_id
         FROM proposal_lineages
        WHERE workspace_id = ? AND id = ? AND originating_submission_id = ?`,
    ).get(fixture.workspaceId, authority.proposalLineageId, fixture.submissionId) as {
      originating_submission_revision_id: string;
    };
    const dashboard = readApplicantSubmissionDashboard(db, {
      workspaceId: fixture.workspaceId,
      callId: fixture.callId,
      sessionTokenHash: fixture.applicantSessionTokenHash,
      submissionId: fixture.submissionId,
    });
    return {
      allocationCount: allocation.count,
      acceptedCommitmentResponseCount: commitments.count,
      participationStatus: speaker.participation_status,
      lineageOriginRevisionId: lineage.originating_submission_revision_id,
      applicantSessionStatus: dashboard?.decision?.handoff?.linkedSession.status ?? null,
    };
  } finally {
    closeDb(db);
  }
}

test("an exactly accepted CFP revision enters the scheduler once and survives a browser reload", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(60_000);
  const health = monitorBrowserHealth(page);
  const fixture = createBrowserFixture();

  await context.addCookies([{
    name: SESSION_COOKIE,
    value: fixture.organizerToken,
    url: ORIGIN,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await page.goto(`/w/${WORKSPACE_SLUG}/events/${fixture.eventId}/cfp/${fixture.callId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("load", { timeout: 60_000 });
  const submissions = page.getByTestId("organizer-cfp-submissions");
  const submissionRow = submissions.getByRole("row").filter({ hasText: fixture.title });
  await expect(submissionRow).toHaveCount(1);
  await expect(submissionRow).toContainText(fixture.title);
  await submissionRow.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(submissions.getByRole("status")).toContainText("Accepted decision recorded.");
  await expect(submissions).toContainText("Session handoff ready");
  await expect(submissions).toContainText("UNSCHEDULED");
  const authority = readAcceptedBrowserAuthority(fixture);

  await page.goto(`/w/${WORKSPACE_SLUG}/events/${fixture.eventId}/program`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("load", { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Plan Studio", level: 1 })).toBeVisible();

  const tray = page.locator('section[aria-labelledby="unscheduled-title"]');
  await expect(tray.getByText("1 in tray", { exact: true })).toBeVisible();
  await expect(tray.getByText(fixture.title, { exact: true })).toBeVisible();
  await expect(page.getByTestId("selected-session-inspector")).toContainText(fixture.applicantName);
  await expect(page.getByTestId("selected-session-inspector")).toContainText("Unscheduled · action required");

  await expect(page.getByTestId("direct-placement-control")).toHaveText("Place session");
  await page.getByTestId("direct-placement-control").click();
  await expect(page.getByTestId("schedule-builder-result")).toContainText("Placed");
  await expect(page.getByTestId("schedule-persistence-status")).toContainText("Saved");
  await expect(tray.getByText("0 in tray", { exact: true })).toBeVisible();
  await expect(page.getByTestId(`schedule-session-${authority.programUnitId}`)).toContainText(fixture.title);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Plan Studio", level: 1 })).toBeVisible();
  await expect(page.getByText("0 in tray", { exact: true })).toBeVisible();
  await expect(page.getByTestId(`schedule-session-${authority.programUnitId}`)).toContainText(fixture.title);
  await expect(page.getByTestId("selected-session-inspector")).toContainText("Placed in the candidate draft");

  expect(readDurableProof(fixture, authority)).toEqual({
    allocationCount: 1,
    acceptedCommitmentResponseCount: 0,
    participationStatus: "INVITED",
    lineageOriginRevisionId: fixture.revisionId,
    applicantSessionStatus: "DRAFT_UNPUBLISHED",
  });

  await context.clearCookies();
  const encodeCookie = (value: object) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  await context.addCookies([
    {
      name: sessionCookieName(WORKSPACE_SLUG, fixture.callSlug),
      value: encodeCookie({
        version: 1,
        workspace: WORKSPACE_SLUG,
        call: fixture.callSlug,
        token: fixture.applicantSessionToken,
      }),
      url: ORIGIN,
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: submissionCookieName(WORKSPACE_SLUG, fixture.callSlug),
      value: encodeCookie({
        version: 1,
        workspace: WORKSPACE_SLUG,
        call: fixture.callSlug,
        submissionId: fixture.submissionId,
      }),
      url: ORIGIN,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const callPath = `/cfp/${WORKSPACE_SLUG}/${fixture.callSlug}`;
  await page.goto(`${callPath}/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  const applicantDashboard = page.getByTestId("applicant-dashboard");
  await expect(applicantDashboard.getByTestId("applicant-linked-session-status")).toHaveText("DRAFT_UNPUBLISHED");
  await expect(applicantDashboard.getByTestId("applicant-linked-session-draft-notice"))
    .toContainText("not authoritative");
  await expect(applicantDashboard).not.toContainText("Main room");
  await expect(applicantDashboard).not.toContainText("Scheduled time");
  expect(health.serverErrors, "unexpected 5xx responses").toEqual([]);
  expect(health.pageErrors, "unexpected browser errors").toEqual([]);
});
