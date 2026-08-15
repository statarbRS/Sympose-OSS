import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createSession, resolveSession, SESSION_COOKIE } from "../../src/server/auth";
import {
  canonicalJson,
  fingerprintOf,
  sha256Hex,
} from "../../src/server/canonical";
import { closeDb, openDb } from "../../src/server/db";
import {
  CFP_REVIEW_EVALUATION_SCHEMA,
  listOwnReviewAssignments,
  readOwnReviewAssignment,
  saveOwnReview,
} from "../../src/server/services/cfp-review";
import {
  BLIND_REVIEW_ATTESTATION,
  BLIND_REVIEW_DISCLOSURE_STAGE,
  CFP_REVIEW_FINGERPRINT_ALGORITHM,
} from "../../src/server/services/cfp-review/artifact-types";
import {
  sealBlindReviewArtifact,
  sealRubricSemantics,
} from "../../src/server/services/cfp-review/organizer-sealing";
import {
  createCall,
  createDraftSubmission,
  createFormDefinition,
  saveDraftRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import { sealRelease } from "../../src/server/services/publication";
import { prepareParticipantReleaseAuthority } from "../helpers/participant-release-authority";

async function exactFingerprint(locator: Locator): Promise<string> {
  const title = await locator.getAttribute("title");
  const fingerprint = title?.match(/([a-f0-9]{64})$/)?.[1];
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  return fingerprint!;
}

async function expectExactFingerprint(locator: Locator, expected: string): Promise<void> {
  expect(await exactFingerprint(locator)).toBe(expected);
}

async function expectNoHorizontalDocumentOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectNoHighImpactAccessibilityViolations(page: Page): Promise<void> {
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

async function saveApplicantDraftAndWait(page: Page): Promise<void> {
  const revision = page.locator(".cfp-revision-label code");
  const before = await revision.getAttribute("title");
  expect(before).toMatch(/^Revision: /u);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(() => revision.getAttribute("title")).not.toBe(before);
}

type ApplicantFixture = {
  readonly workspaceSlug: string;
  readonly callSlug: string;
  readonly email: string;
};

function createApplicantFixture(): ApplicantFixture {
  const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
  try {
    const workspaceSlug = "northstar";
    const organizer = db
      .prepare(
        `SELECT w.id AS workspaceId, a.id AS accountId
         FROM workspaces AS w
         JOIN accounts AS a ON a.workspace_id = w.id
         WHERE w.slug = ? AND a.role = 'organizer'
         ORDER BY a.id
         LIMIT 1`,
      )
      .get(workspaceSlug) as { workspaceId: string; accountId: string } | undefined;
    if (!organizer) throw new Error("missing synthetic organizer fixture");

    const suffix = randomUUID().slice(0, 8);
    const now = new Date();
    const eventId = randomUUID();
    const startsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const endsAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO events
         (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      organizer.workspaceId,
      `Applicant UI event ${suffix}`,
      "UTC",
      startsAt,
      endsAt,
      "planning",
      now.toISOString(),
    );

    const formDefinition = createFormDefinition(db, organizer, {
      name: `Applicant form ${suffix}`,
    });
    const formVersion = sealFormVersion(db, organizer, {
      formDefinitionId: formDefinition.id,
      fields: [
        {
          id: "title",
          type: "shortText",
          label: "Proposal title",
          required: true,
          defaultVisibility: "visible",
          config: {
            guidance: "Use a clear title for the program team.",
            maxLength: 160,
          },
        },
        {
          id: "format",
          type: "singleChoice",
          label: "Session format",
          required: true,
          defaultVisibility: "visible",
          config: {
            options: [
              { value: "Talk", label: "Talk" },
              { value: "Workshop", label: "Workshop" },
            ],
          },
        },
        {
          id: "workshop_plan",
          type: "longText",
          label: "Workshop plan",
          required: true,
          defaultVisibility: "hidden",
          config: { guidance: "Describe how participants will work together." },
        },
        {
          id: "abstract",
          type: "longText",
          label: "Abstract",
          required: true,
          defaultVisibility: "visible",
        },
        {
          id: "privacy_ack",
          type: "consent",
          label: "Privacy acknowledgement",
          required: true,
          defaultVisibility: "visible",
        },
      ],
      rules: {
        schema: FORM_RULES_SCHEMA,
        rules: [
          {
            id: "show-workshop-plan",
            condition: {
              kind: "field",
              fieldId: "format",
              operator: "equals",
              value: "Workshop",
            },
            actions: [{ type: "show", targetFieldId: "workshop_plan" }],
          },
        ],
      },
    });
    const callSlug = `community-stage-${suffix}`;
    createCall(db, organizer, {
      eventId,
      name: "Community Stage 2027",
      slug: callSlug,
      formVersionId: formVersion.id,
      policy: {
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
      },
      accessMode: "PUBLIC",
      state: "OPEN",
      timezone: "UTC",
      opensAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      closesAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });

    const email = `applicant-${suffix}@example.test`;
    return {
      workspaceSlug,
      callSlug,
      email,
    };
  } finally {
    closeDb(db);
  }
}

type ReviewerFixture = {
  readonly workspaceSlug: string;
  readonly assignmentId: string;
  readonly reviewerToken: string;
  readonly otherReviewerToken: string;
  readonly organizerToken: string;
  readonly safeSummary: string;
  readonly sourceEmail: string;
  readonly sourceName: string;
  readonly sourceHistory: string;
  readonly suffix: string;
};

function createReviewerFixture(): ReviewerFixture {
  const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
  try {
    const workspaceSlug = "northstar";
    const organizer = db
      .prepare(
        `SELECT w.id AS workspaceId, a.id AS accountId
         FROM workspaces AS w
         JOIN accounts AS a ON a.workspace_id = w.id
         WHERE w.slug = ? AND a.role = 'organizer'
         ORDER BY a.id
         LIMIT 1`,
      )
      .get(workspaceSlug) as { workspaceId: string; accountId: string } | undefined;
    if (!organizer) throw new Error("missing synthetic organizer fixture");

    const suffix = randomUUID().slice(0, 8);
    const createdAt = new Date().toISOString();
    const reviewerId = `reviewer-e2e-${suffix}`;
    const otherReviewerId = `reviewer-other-e2e-${suffix}`;
    db.prepare(
      `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
       VALUES (?, ?, ?, 'Rae E2E Reviewer', 'reviewer', ?),
              (?, ?, ?, 'Other E2E Reviewer', 'reviewer', ?)`,
    ).run(
      reviewerId,
      organizer.workspaceId,
      `rae-reviewer-${suffix}@synthetic.example`,
      createdAt,
      otherReviewerId,
      organizer.workspaceId,
      `other-reviewer-${suffix}@synthetic.example`,
      createdAt,
    );

    const eventId = randomUUID();
    db.prepare(
      `INSERT INTO events
         (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
    ).run(
      eventId,
      organizer.workspaceId,
      `Reviewer E2E event ${suffix}`,
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt,
    );

    const organizerContext = {
      workspaceId: organizer.workspaceId,
      accountId: organizer.accountId,
    };
    const definition = createFormDefinition(db, organizerContext, {
      name: `Reviewer E2E form ${suffix}`,
    });
    const form = sealFormVersion(db, organizerContext, {
      formDefinitionId: definition.id,
      fields: [
        {
          id: "proposalSummary",
          type: "longText",
          label: "Source proposal summary",
          required: true,
          defaultVisibility: "visible",
        },
        {
          id: "sessionFormat",
          type: "singleChoice",
          label: "Source session format",
          required: true,
          defaultVisibility: "visible",
          config: {
            options: [
              { value: "Talk", label: "Talk" },
              { value: "Workshop", label: "Workshop" },
            ],
          },
        },
        {
          id: "applicantName",
          type: "shortText",
          label: "Source applicant name",
          required: true,
          defaultVisibility: "visible",
        },
        {
          id: "applicantEmail",
          type: "email",
          label: "Source applicant email",
          required: true,
          defaultVisibility: "visible",
        },
        {
          id: "privateHistory",
          type: "shortText",
          label: "Source private history",
          required: false,
          defaultVisibility: "hidden",
        },
      ],
      rules: { schema: FORM_RULES_SCHEMA, rules: [] },
    });
    const call = createCall(db, organizerContext, {
      eventId,
      name: `Reviewer E2E call ${suffix}`,
      slug: `reviewer-e2e-call-${suffix}`,
      formVersionId: form.id,
      policy: {
        disclosure: {
          privacy: "Synthetic reviewer fixture privacy notice.",
          retention: "Synthetic reviewer fixture retention notice.",
          aiProcessing: "No AI processing is used in this fixture.",
          communication: "Synthetic fixture communication only.",
          consent: "Synthetic fixture consent only.",
          publication: "Synthetic fixture publication only.",
        },
        choices: [],
      },
    });

    const sourceEmail = `applicant-secret-${suffix}@identity.example`;
    const sourceName = `Applicant Secret ${suffix}`;
    const sourceHistory = `Unredacted historical answer ${suffix}`;
    const personId = randomUUID();
    const verificationId = randomUUID();
    const applicantSessionId = randomUUID();
    db.prepare(
      `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(personId, organizer.workspaceId, sourceEmail, sourceName, createdAt);
    db.prepare(
      `INSERT INTO cfp_email_verifications
         (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, '2099-08-11T00:00:00.000Z', ?)`,
    ).run(
      verificationId,
      organizer.workspaceId,
      call.id,
      sourceEmail,
      "c".repeat(64),
      createdAt,
    );
    db.prepare(
      `INSERT INTO cfp_email_verification_consumptions
         (id, workspace_id, verification_id, person_id, consumed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), organizer.workspaceId, verificationId, personId, createdAt);
    db.prepare(
      `INSERT INTO cfp_applicant_sessions
         (id, workspace_id, call_id, person_id, verification_id,
          token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2099-08-11T00:00:00.000Z')`,
    ).run(
      applicantSessionId,
      organizer.workspaceId,
      call.id,
      personId,
      verificationId,
      "d".repeat(64),
      createdAt,
    );
    const submission = createDraftSubmission(
      db,
      { workspaceId: organizer.workspaceId, sessionId: applicantSessionId },
      { callId: call.id },
    );
    const saved = saveDraftRevision(
      db,
      { workspaceId: organizer.workspaceId, sessionId: applicantSessionId },
      {
        submissionId: submission.id,
        expectedCurrentRevisionId: null,
        historicalAnswers: [
          {
            fieldId: "proposalSummary",
            value: `Source summary identifying ${sourceName}`,
          },
          { fieldId: "sessionFormat", value: "Workshop" },
          { fieldId: "applicantName", value: sourceName },
          { fieldId: "applicantEmail", value: sourceEmail },
          { fieldId: "privateHistory", value: sourceHistory },
        ],
      },
    );
    db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(submission.id);
    const revision = db
      .prepare("SELECT created_at FROM submission_revisions WHERE id = ?")
      .get(saved.revisionId) as { created_at: string } | undefined;
    if (!revision) throw new Error("missing synthetic reviewer revision");

    const roundId = randomUUID();
    const rubricVersionId = randomUUID();
    const assignmentId = randomUUID();
    db.prepare(
      `INSERT INTO review_rounds
         (id, workspace_id, event_id, call_id, name, created_by, created_at)
       VALUES (?, ?, ?, ?, 'Community review round', ?, ?)`,
    ).run(
      roundId,
      organizer.workspaceId,
      eventId,
      call.id,
      organizer.accountId,
      revision.created_at,
    );
    const rubricDocument = {
      schema: "cfp-rubric/v1",
      criteria: ["quality", "recommendation", "notes"],
      fixture: suffix,
    };
    const rubricFingerprint = fingerprintOf(rubricDocument);
    db.prepare(
      `INSERT INTO rubric_versions
         (id, workspace_id, round_id, version_number, rubric_schema, rubric_json,
          fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
       VALUES (?, ?, ?, 1, 'cfp-rubric/v1', ?, ?, ?, ?, ?)`,
    ).run(
      rubricVersionId,
      organizer.workspaceId,
      roundId,
      canonicalJson(rubricDocument),
      CFP_REVIEW_FINGERPRINT_ALGORITHM,
      rubricFingerprint,
      organizer.accountId,
      revision.created_at,
    );
    db.prepare(
      `INSERT INTO review_assignments
         (id, workspace_id, round_id, rubric_version_id, submission_id,
          submission_revision_id, reviewer_account_id, assigned_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      assignmentId,
      organizer.workspaceId,
      roundId,
      rubricVersionId,
      submission.id,
      saved.revisionId,
      reviewerId,
      organizer.accountId,
      revision.created_at,
    );

    const organizerSession = createSession(
      db,
      organizer.accountId,
      organizer.workspaceId,
    );
    sealRubricSemantics(db, organizerSession.session, {
      workspaceSlug,
      rubricVersionId,
      expectedRubricFingerprint: rubricFingerprint,
      idempotencyKey: `reviewer-e2e-rubric-${suffix}`,
      criteria: [
        {
          semantic: "PROPOSAL_QUALITY",
          kind: "numeric",
          required: true,
          weight: 2,
          minimum: 1,
          maximum: 5,
          step: 1,
        },
        {
          semantic: "INDEPENDENT_RECOMMENDATION",
          kind: "recommendation",
          required: true,
          weight: 1,
        },
        {
          semantic: "REVIEWER_NOTES",
          kind: "comment",
          required: false,
          weight: 0,
          maxLength: 500,
        },
      ],
    });
    const safeSummary = "A blind-safe community workshop about accessible local collaboration.";
    const artifact = sealBlindReviewArtifact(db, organizerSession.session, {
      workspaceSlug,
      assignmentId,
      expectedSubmissionRevisionId: saved.revisionId,
      expectedSubmissionRevisionFingerprint: saved.revision.fingerprint,
      expectedConflictSequence: 0,
      stage: BLIND_REVIEW_DISCLOSURE_STAGE,
      attestation: BLIND_REVIEW_ATTESTATION,
      idempotencyKey: `reviewer-e2e-artifact-${suffix}`,
      decisions: [
        {
          sourceFieldId: "proposalSummary",
          action: "INCLUDE_REDACTED",
          reviewLabel: "Proposal summary",
          redactedValue: safeSummary,
        },
        {
          sourceFieldId: "sessionFormat",
          action: "INCLUDE_REDACTED",
          reviewLabel: "Session format",
          redactedValue: "Workshop",
        },
        { sourceFieldId: "applicantName", action: "EXCLUDE" },
        { sourceFieldId: "applicantEmail", action: "EXCLUDE" },
      ],
    });
    db.prepare(
      `INSERT INTO review_round_states
         (id, workspace_id, round_id, state, sequence_number,
          actor_account_id, reason, created_at)
       VALUES (?, ?, ?, 'OPEN', 2, ?, 'Open reviewer E2E round', ?)`,
    ).run(
      randomUUID(),
      organizer.workspaceId,
      roundId,
      organizer.accountId,
      new Date(Date.parse(artifact.issuedAt) + 1).toISOString(),
    );

    const reviewerSession = createSession(db, reviewerId, organizer.workspaceId);
    const otherReviewerSession = createSession(db, otherReviewerId, organizer.workspaceId);
    return {
      workspaceSlug,
      assignmentId,
      reviewerToken: reviewerSession.token,
      otherReviewerToken: otherReviewerSession.token,
      organizerToken: organizerSession.token,
      safeSummary,
      sourceEmail,
      sourceName,
      sourceHistory,
      suffix,
    };
  } finally {
    closeDb(db);
  }
}

async function useWorkspaceSession(
  context: BrowserContext,
  origin: string,
  token: string,
): Promise<void> {
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function openEvaluatorControls(page: Page): Promise<void> {
  const disclosure = page.getByTestId("evaluator-disclosure");
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await disclosure.locator(":scope > summary").click();
  }
  await expect(disclosure).toHaveJSProperty("open", true);
}

function createNorthstarOrganizerSession(): string {
  const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
  try {
    const organizer = db
      .prepare(
        `SELECT a.id AS accountId, a.workspace_id AS workspaceId
         FROM accounts AS a
         JOIN workspaces AS w ON w.id = a.workspace_id
         WHERE w.slug = ? AND a.role = 'organizer'
         ORDER BY a.id
         LIMIT 1`,
      )
      .get("northstar") as { accountId: string; workspaceId: string } | undefined;
    if (!organizer) throw new Error("missing Northstar organizer fixture");
    return createSession(db, organizer.accountId, organizer.workspaceId).token;
  } finally {
    closeDb(db);
  }
}

function sealNorthstarParticipantRelease(eventId: string): ReturnType<typeof sealRelease> {
  const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
  try {
    const authority = db.prepare(
      `SELECT w.id AS workspaceId, a.id AS accountId
         FROM workspaces AS w
         JOIN accounts AS a ON a.workspace_id = w.id
        WHERE w.slug = 'northstar' AND a.role = 'organizer'
        ORDER BY a.id
        LIMIT 1`,
    ).get() as { workspaceId: string; accountId: string } | undefined;
    if (!authority) throw new Error("missing Northstar release authority");
    const actor = { kind: "account" as const, ref: authority.accountId };
    prepareParticipantReleaseAuthority(db, authority.workspaceId, eventId, actor);
    return sealRelease(db, authority.workspaceId, eventId, actor);
  } finally {
    closeDb(db);
  }
}

function appendConcurrentReviewerRevision(fixture: ReviewerFixture): void {
  const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
  try {
    const session = resolveSession(db, fixture.reviewerToken);
    if (!session) throw new Error("missing reviewer session for stale fixture");
    const detail = readOwnReviewAssignment(db, session, {
      workspaceSlug: fixture.workspaceSlug,
      assignmentId: fixture.assignmentId,
    });
    saveOwnReview(db, session, {
      workspaceSlug: fixture.workspaceSlug,
      assignmentId: fixture.assignmentId,
      expectedAssignmentStateSequenceNumber: detail.assignmentStateSequenceNumber,
      expectedReviewRevisionNumber: detail.latestReviewRevisionNumber,
      idempotencyKey: `reviewer-e2e-concurrent-${fixture.suffix}`,
      evaluation: {
        schema: CFP_REVIEW_EVALUATION_SCHEMA,
        responses: [
          { criterionId: "criterion-0001", value: 2 },
          { criterionId: "criterion-0002", value: "HOLD" },
          { criterionId: "criterion-0003", value: "Concurrent authoritative evidence." },
        ],
      },
    });
  } finally {
    closeDb(db);
  }
}

test("fixture evidence reaches an observed outcome without crossing truth or workspace boundaries", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);

  const unauthenticated = await context.newPage();
  await unauthenticated.goto("/w/northstar/dashboard");
  await expect(unauthenticated).toHaveURL(/\/\?reason=session-expired$/);
  await unauthenticated.close();

  await page.goto("/");
  await expect(page).toHaveTitle(/Sympose MVP/);
  await useWorkspaceSession(context, new URL(page.url()).origin, createNorthstarOrganizerSession());
  await page.goto("/w/northstar/dashboard");
  await expect(page).toHaveURL(/\/w\/northstar\/dashboard$/);
  const workspaceHome = page.getByRole("region", { name: "Today" });
  await expect(
    workspaceHome.getByRole("heading", { name: "Today", level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".shell__account-avatar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  let skipLinkReached = false;
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    skipLinkReached = await skipLink.evaluate((element) => element === document.activeElement);
    if (skipLinkReached) break;
  }
  expect(skipLinkReached).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main-content$/);
  await openEvaluatorControls(page);

  const importCard = page.getByRole("region", { name: "Import provider evidence" });
  await importCard.getByRole("button", { name: "Import fixture evidence" }).click();
  await expect(importCard.getByRole("status")).toContainText("Imported 12 evidence rows");
  await expect(page.getByText("Jane Oakley", { exact: true })).toBeVisible();

  const snapshotCard = page.getByRole("region", { name: "Freeze cohort snapshot" });
  await snapshotCard.getByRole("button", { name: "Freeze snapshot" }).click();
  await expect(snapshotCard.getByRole("status")).toContainText(/Frozen cohort snapshot|already frozen/);
  await expect(page.locator(".dash__people-table .badge--qualified")).toHaveCount(12);
  const snapshotFingerprint = await exactFingerprint(snapshotCard.locator(".fp"));

  const eventCard = page.getByRole("region", { name: "Create event and program unit" });
  await eventCard.getByLabel("Event name").fill("Sympose MVP Roundtable");
  await eventCard.getByLabel("Program unit name").fill("Morning circle");
  await eventCard.getByLabel("Capacity").fill("6");
  await eventCard.getByRole("button", { name: "Create event" }).click();
  await expect(eventCard.getByRole("status")).toContainText('Created event "Sympose MVP Roundtable"');

  const compileCard = page.getByRole("region", { name: "Compile candidate plan" });
  await compileCard.getByRole("button", { name: "Compile plan" }).click();
  await expect(compileCard.getByRole("status")).toContainText("Compiled candidate plan v1");
  const candidateFingerprint = await exactFingerprint(compileCard.locator(".fp"));
  await expectExactFingerprint(snapshotCard.locator(".fp"), snapshotFingerprint);

  const approvalCard = page.getByRole("region", { name: "Approve plan (separate decision)" });
  await approvalCard.getByRole("button", { name: "Approve candidate plan" }).click();
  await expect(approvalCard.getByRole("status")).toContainText("Plan approved");
  await expectExactFingerprint(compileCard.locator(".fp"), candidateFingerprint);

  await page.getByRole("link", { name: "Review immutable plan and explanations" }).click();
  await expect(page).toHaveURL(/\/events\/[^/]+\/plan$/);
  const eventId = new URL(page.url()).pathname.match(/\/events\/([^/]+)\/plan$/u)?.[1];
  if (!eventId) throw new Error("the approved plan route lost its event scope");
  await expect(page.getByTestId("plan-review")).toContainText("Frozen compiler receipt");
  await expect(page.getByTestId("plan-review")).toContainText("Organizer approval appended");
  await expect(page.getByTestId("plan-review")).toContainText("Run outcome");
  await expect(page.getByTestId("plan-review")).toContainText("Lifecycle");
  await expect(page.getByRole("table")).toContainText("Moderator-eligible per fixture evidence");
  await expectNoHighImpactAccessibilityViolations(page);
  await page.getByRole("navigation", { name: "Event product surfaces" }).getByRole("link", { name: "All events" }).click();
  await expect(page).toHaveURL(/\/w\/northstar\/events$/);
  await page.getByRole("navigation", { name: "Workspace event navigation" }).getByRole("link", { name: "Workspace dashboard" }).click();
  await openEvaluatorControls(page);

  const offersCard = page.getByRole("region", { name: "Deliver exact offers" });
  await offersCard.getByRole("button", { name: "Deliver offers" }).click();
  await expect(offersCard.getByRole("status")).toContainText("Delivered 6 exact offer envelopes");

  const acceptanceCard = page.getByRole("region", { name: "Simulate one acceptance" });
  await acceptanceCard.getByRole("button", { name: "Simulate one acceptance" }).click();
  await expect(acceptanceCard.getByRole("status")).toContainText("Person accepted the exact offer");
  await expectExactFingerprint(snapshotCard.locator(".fp"), snapshotFingerprint);
  await expectExactFingerprint(compileCard.locator(".fp"), candidateFingerprint);

  const sealedRelease = sealNorthstarParticipantRelease(eventId);
  expect(sealedRelease.created).toBe(true);
  expect(sealedRelease.tokens).toHaveLength(1);
  const oneTimeAgenda = sealedRelease.tokens[0]!;
  const acceptedPersonName = oneTimeAgenda.personName;
  const agendaHref = `/p/${oneTimeAgenda.rawToken}`;
  const releaseFingerprint = sealedRelease.fingerprint;
  await page.reload();
  await openEvaluatorControls(page);
  const releaseCard = page.getByRole("region", { name: "Review publication readiness" });
  await expectExactFingerprint(snapshotCard.locator(".fp"), snapshotFingerprint);
  await expectExactFingerprint(compileCard.locator(".fp"), candidateFingerprint);
  await expectExactFingerprint(releaseCard.locator(".fp"), releaseFingerprint);
  await expect(page.locator(".action-card--next")).toHaveCount(1);
  await expect(page.locator(".action-card--next")).toContainText("Record attendance");
  await expect(page.locator(".action-card--caution.action-card--next")).toHaveCount(0);

  const portal = await context.newPage();
  await portal.goto(agendaHref ?? "/p/invalid");
  await expect(portal.getByTestId("personal-agenda")).toContainText("Sympose MVP Roundtable");
  await expect(portal.getByTestId("personal-agenda")).toContainText(acceptedPersonName);
  await expectExactFingerprint(
    portal.getByTestId("personal-agenda").locator(".fp"),
    releaseFingerprint,
  );
  await expectNoHighImpactAccessibilityViolations(portal);
  for (const width of [390, 768, 1024, 1440]) {
    await portal.setViewportSize({ width, height: 900 });
    await expectNoHorizontalDocumentOverflow(portal);
    if (width === 390) {
      await expect(portal.locator('[data-role-instrument="participant"]')).toBeVisible();
      const evidenceDirectory = process.env.SYMPOSE_EVIDENCE_DIR;
      if (evidenceDirectory) {
        mkdirSync(evidenceDirectory, { recursive: true });
        await portal.screenshot({
          path: resolve(evidenceDirectory, "participant-instrument-390.png"),
          fullPage: false,
        });
      }
    }
  }

  await openEvaluatorControls(page);
  const revokeCard = page.getByRole("region", { name: "Revoke a portal token" });
  await revokeCard.getByRole("button", { name: "Revoke token" }).click();
  await expect(revokeCard.getByRole("status")).toContainText("Portal access revoked");
  await expectExactFingerprint(snapshotCard.locator(".fp"), snapshotFingerprint);
  await expectExactFingerprint(compileCard.locator(".fp"), candidateFingerprint);
  await expectExactFingerprint(releaseCard.locator(".fp"), releaseFingerprint);
  await portal.reload();
  await expect(portal.getByTestId("portal-denied")).toContainText("TOKEN_REVOKED");
  await portal.close();
  await expect(page.locator(".action-card--next")).toHaveCount(1);
  await expect(page.locator(".action-card--next")).toContainText("Record attendance");

  await openEvaluatorControls(page);
  const attendanceCard = page.getByRole("region", { name: "Record attendance" });
  const acceptedPersonOption = attendanceCard
    .getByLabel("Person")
    .locator("option")
    .filter({ hasText: acceptedPersonName });
  const acceptedPersonId = await acceptedPersonOption.getAttribute("value");
  await attendanceCard.getByLabel("Person").selectOption(acceptedPersonId ?? "");
  await attendanceCard.getByRole("button", { name: "Record attendance" }).click();
  await expect(attendanceCard.getByRole("status")).toContainText("Attendance recorded as operational truth");
  await attendanceCard.getByLabel("Person").selectOption(acceptedPersonId ?? "");
  await attendanceCard.getByRole("button", { name: "Record attendance" }).click();
  await expect(attendanceCard.getByRole("status")).toContainText("duplicate submission was ignored");
  await expectExactFingerprint(snapshotCard.locator(".fp"), snapshotFingerprint);
  await expectExactFingerprint(compileCard.locator(".fp"), candidateFingerprint);
  await expectExactFingerprint(releaseCard.locator(".fp"), releaseFingerprint);

  await page.locator(".dash__people").getByRole("link", { name: acceptedPersonName, exact: true }).click();
  await page.waitForURL(/\/w\/northstar\/people\/[^/]+$/u, { timeout: 20_000 });
  const provenance = page.getByTestId("person-provenance");
  await expect(provenance).toContainText("auto-resolve");
  const ledger = page.getByTestId("truth-ledger");
  await expect(ledger).toContainText("Qualified in cohort snapshot");
  await expect(ledger).toContainText("Candidate assignment");
  await expect(ledger).toContainText("Organizer approved plan");
  await expect(ledger).toContainText("Commitment accepted");
  await expect(ledger).toContainText("Personal agenda materialized");
  await expect(ledger).toContainText("Attendance observed");
  await expectNoHighImpactAccessibilityViolations(page);
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Dashboard" }).click();
  await openEvaluatorControls(page);

  const denialCard = page.getByRole("region", { name: "Prove cross-workspace denial" });
  await denialCard.getByRole("button", { name: "Attempt denied access" }).click();
  await expect(denialCard.getByRole("status")).toContainText("CROSS_WORKSPACE_DENIED");
  await page.goto("/w/acme/dashboard");
  await expect(page.getByText("404")).toBeVisible();
  await page.goto("/w/northstar/dashboard");
  await openEvaluatorControls(page);
  await expect(page.locator(".dash__audit")).toContainText("security.access.denied");
  await expect(page.locator(".action-card--row")).toHaveCount(11);
  await expect(page.locator(".dash__people table")).toBeVisible();
  await expect(page.locator(".action-card--next")).toHaveCount(0);
  await expect(page.locator(".action-card--boundary")).toBeVisible();
  await expectNoHighImpactAccessibilityViolations(page);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalDocumentOverflow(page);
  }
});

test("applicant verifies, reconciles the conditional draft, saves, and submits the exact revision", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const fixture = createApplicantFixture();
  const callPath = `/cfp/${fixture.workspaceSlug}/${fixture.callSlug}`;
  const simulatedJourneyRequestUrls: string[] = [];
  page.on("request", (request) => {
    simulatedJourneyRequestUrls.push(request.url());
  });

  await page.goto(callPath);
  await expect(page).toHaveURL(new RegExp(`${callPath}$`));
  await expect(page.getByTestId("applicant-call")).toContainText("Community Stage 2027");
  await expect(page.getByText("No AI processing is used in this call.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "href",
    `${callPath}/dashboard`,
  );
  await expect(page.locator('a[href^="/w/"]')).toHaveCount(0);
  await expect(page.getByText("Organizer console", { exact: false })).toHaveCount(0);
  await expectNoHighImpactAccessibilityViolations(page);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalDocumentOverflow(page);
  }

  await page.getByRole("link", { name: "Verify your email" }).click();
  await page.getByLabel("Email address").fill(fixture.email);
  await page.getByRole("button", { name: "Send verification link" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If this address can be verified for this call",
  );

  const cookieScope = sha256Hex(
    `${fixture.workspaceSlug}\u0000${fixture.callSlug}`,
  ).slice(0, 24);
  const deliveryCookieName = `sympose_cfp_simulated_delivery_${cookieScope}`;
  const verificationCookieName = `sympose_cfp_verification_${cookieScope}`;
  const sessionCookieName = `sympose_cfp_applicant_${cookieScope}`;
  const deliveredCookie = (await context.cookies()).find(
    (cookie) => cookie.name === deliveryCookieName,
  );
  expect(deliveredCookie?.httpOnly).toBe(true);
  expect(deliveredCookie?.path).toBe(`${callPath}/local-inbox`);
  if (!deliveredCookie) throw new Error("missing simulated verification delivery cookie");
  const deliveredPayload: unknown = JSON.parse(
    Buffer.from(deliveredCookie.value, "base64url").toString("utf8"),
  );
  if (
    deliveredPayload === null ||
    typeof deliveredPayload !== "object" ||
    Array.isArray(deliveredPayload)
  ) {
    throw new Error("malformed simulated verification delivery cookie");
  }
  const deliveredRecord = deliveredPayload as Record<string, unknown>;
  if (
    typeof deliveredRecord.verificationId !== "string" ||
    typeof deliveredRecord.token !== "string"
  ) {
    throw new Error("simulated verification delivery credentials are malformed");
  }
  const deliveredVerificationId = deliveredRecord.verificationId;
  const deliveredToken = deliveredRecord.token;
  expect(deliveredRecord.workspace).toBe(fixture.workspaceSlug);
  expect(deliveredRecord.call).toBe(fixture.callSlug);
  const actionMarkup = await page.content();
  expect(actionMarkup.includes(deliveredVerificationId)).toBe(false);
  expect(actionMarkup.includes(deliveredToken)).toBe(false);

  const applicantOrigin = new URL(page.url()).origin;
  await page.getByRole("link", { name: "Open local simulated inbox" }).click();
  await expect(page).toHaveURL(new RegExp(`${callPath}/local-inbox$`));
  await expect(page.getByTestId("simulated-verification-inbox")).toContainText(fixture.email);
  expect(page.url()).not.toContain("token=");
  const inboxMarkup = await page.content();
  expect(inboxMarkup.includes(deliveredVerificationId)).toBe(false);
  expect(inboxMarkup.includes(deliveredToken)).toBe(false);

  await page.getByRole("link", { name: "Open delivered verification link" }).click();
  await expect(page).toHaveURL(new RegExp(`${callPath}/verify$`));
  expect(new URL(page.url()).origin).toBe(applicantOrigin);
  expect(page.url()).not.toContain("token=");
  expect(page.url()).not.toContain("verification=");
  const credentialFreeRequestUrls = simulatedJourneyRequestUrls.every((requestUrl) => {
    const parsed = new URL(requestUrl);
    return (
      !requestUrl.includes(deliveredVerificationId) &&
      !requestUrl.includes(deliveredToken) &&
      !parsed.searchParams.has("verification") &&
      !parsed.searchParams.has("token")
    );
  });
  expect(credentialFreeRequestUrls).toBe(true);
  expect(
    simulatedJourneyRequestUrls.some(
      (requestUrl) => new URL(requestUrl).pathname === `${callPath}/local-inbox/open`,
    ),
  ).toBe(true);
  expect(
    simulatedJourneyRequestUrls.some(
      (requestUrl) => new URL(requestUrl).pathname === `${callPath}/access`,
    ),
  ).toBe(false);
  const verifyMarkup = await page.content();
  expect(verifyMarkup.includes(deliveredVerificationId)).toBe(false);
  expect(verifyMarkup.includes(deliveredToken)).toBe(false);
  const accessCookies = await context.cookies();
  const capturedCookie = accessCookies.find(
    (cookie) => cookie.name === verificationCookieName,
  );
  expect(capturedCookie?.httpOnly).toBe(true);
  expect(capturedCookie?.secure).toBe(false);
  expect(capturedCookie?.sameSite).toBe("Lax");
  expect(capturedCookie?.path).toBe("/cfp");
  expect(capturedCookie?.expires ?? 0).toBeGreaterThan(Date.now() / 1_000 + 14 * 60);
  expect(capturedCookie?.expires ?? 0).toBeLessThanOrEqual(Date.now() / 1_000 + 15 * 60 + 5);
  const expectedPendingCookie = Buffer.from(
    JSON.stringify({
      version: 1,
      workspace: fixture.workspaceSlug,
      call: fixture.callSlug,
      verificationId: deliveredVerificationId,
      token: deliveredToken,
    }),
    "utf8",
  ).toString("base64url");
  expect(capturedCookie?.value === expectedPendingCookie).toBe(true);
  expect(accessCookies.some((cookie) => cookie.name === deliveryCookieName)).toBe(false);

  await page.getByLabel("Full name").fill("Alex Applicant");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`${callPath}/draft$`));
  const verifiedCookies = await context.cookies();
  expect(
    verifiedCookies.find((cookie) => cookie.name === sessionCookieName)?.httpOnly,
  ).toBe(true);
  expect(
    verifiedCookies.some((cookie) => cookie.name === verificationCookieName),
  ).toBe(false);

  await page.getByRole("button", { name: "Create or resume draft" }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === `${callPath}/draft` && url.searchParams.get("saved") === "1",
  );
  await expect(page.getByRole("status")).toContainText("Draft saved");
  await expect(page.getByLabel("Workshop plan")).toHaveCount(0);

  await page.getByLabel("Proposal title").fill("Keeping histories honest");
  await page.getByLabel("Session format").selectOption("Workshop");
  await saveApplicantDraftAndWait(page);
  await expect(page).toHaveURL(
    (url) => url.pathname === `${callPath}/draft` && url.searchParams.get("saved") === "1",
  );
  await expect(page.getByLabel("Workshop plan")).toBeVisible();

  await page
    .getByLabel("Workshop plan")
    .fill("Participants map a conditional workflow in small groups.");
  await page.getByLabel("Abstract").fill("A practical session about preserving truth across revisions.");
  await page.getByLabel("I accept the applicant privacy notice.").check();
  await saveApplicantDraftAndWait(page);
  await expect(page.getByRole("status")).toContainText("Draft saved");

  await page.getByLabel("Session format").selectOption("Talk");
  await saveApplicantDraftAndWait(page);
  await expect(page.getByLabel("Workshop plan")).toHaveCount(0);
  await expect(page.locator(".cfp-hidden-answer-notice")).toContainText(
    "1 answer is currently hidden",
  );
  expect(await page.content()).not.toContain(
    "Participants map a conditional workflow in small groups.",
  );

  await page.getByLabel("Session format").selectOption("Workshop");
  await saveApplicantDraftAndWait(page);
  await expect(page.getByLabel("Workshop plan")).toHaveValue(
    "Participants map a conditional workflow in small groups.",
  );
  await expectNoHighImpactAccessibilityViolations(page);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalDocumentOverflow(page);
  }

  await page.getByRole("button", { name: "Submit saved revision" }).click();
  const receipt = page.getByTestId("applicant-submission-receipt");
  await expect(receipt.getByRole("heading", { name: "Submission received" })).toBeFocused();
  await expect(receipt).toContainText("Immutable submission receipt");
  await expect(receipt.getByText("Submitted", { exact: true })).toBeVisible();
  const receiptRevision = (await receipt.locator("dd code").nth(1).textContent())?.trim();
  expect(receiptRevision).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/);
  await expectNoHighImpactAccessibilityViolations(page);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Amend your submitted proposal" })).toBeVisible();
  await expect(page.getByText("Immutable submitted proposal", { exact: true })).toBeVisible();
  await expect(page.locator(".cfp-revision-label code")).toHaveAttribute(
    "title",
    `Revision: ${receiptRevision}`,
  );
  await expect(page.getByRole("button", { name: "Save draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit saved revision" })).toHaveCount(0);

  await page.getByRole("navigation", { name: "Application progress" })
    .getByRole("link", { name: /Check status/ })
    .click();
  await expect(page.getByTestId("applicant-submission-status")).toHaveText("SUBMITTED");
  await expect(page.getByTestId("applicant-dashboard")).toContainText("Submission received");
  await expect(page.getByTestId("applicant-dashboard")).toContainText(receiptRevision);
  await expect(page.getByRole("link", { name: "Edit submitted proposal" })).toBeVisible();
});

test("reviewer opens the exact blind packet while actor and workspace boundaries stay closed", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const fixture = createReviewerFixture();
  const origin = new URL(page.url()).origin;
  const assignmentPath = `/review/${fixture.workspaceSlug}/assignments/${fixture.assignmentId}`;

  await useWorkspaceSession(context, origin, fixture.reviewerToken);
  await page.goto(assignmentPath);
  await expect(page.getByRole("heading", { name: "Independent proposal review" })).toBeVisible();
  await expect(page.getByText(fixture.safeSummary)).toBeVisible();
  let rendered = await page.content();
  expect(rendered).not.toContain(fixture.sourceEmail);
  expect(rendered).not.toContain(fixture.sourceName);
  expect(rendered).not.toContain(fixture.sourceHistory);
  expect(rendered).not.toContain("Source applicant email");
  expect(rendered).not.toContain("Source applicant name");

  await useWorkspaceSession(context, origin, fixture.otherReviewerToken);
  await page.goto(assignmentPath);
  await expect(page.getByRole("heading", { name: "Review unavailable" })).toBeVisible();
  await expect(page.getByText(fixture.safeSummary)).toHaveCount(0);

  await useWorkspaceSession(context, origin, fixture.organizerToken);
  await page.goto(assignmentPath);
  await expect(page.getByRole("heading", { name: "Review unavailable" })).toBeVisible();
  await expect(page.getByText(fixture.safeSummary)).toHaveCount(0);

  await useWorkspaceSession(context, origin, fixture.reviewerToken);
  await page.goto(`/review/acme/assignments/${fixture.assignmentId}`);
  await expect(page.getByRole("heading", { name: "Review unavailable" })).toBeVisible();
  await expect(page.getByText(fixture.safeSummary)).toHaveCount(0);
  rendered = await page.content();
  expect(rendered).not.toContain(fixture.sourceEmail);
  expect(rendered).not.toContain(fixture.sourceName);
});

test("reviewer resolves conflict, reviews the blind projection, reconciles stale work, and submits", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const fixture = createReviewerFixture();
  const origin = new URL(page.url()).origin;
  const queuePath = `/review/${fixture.workspaceSlug}/queue`;
  const assignmentPath = `${queuePath.replace(/\/queue$/u, "")}/assignments/${fixture.assignmentId}`;

  await useWorkspaceSession(context, origin, fixture.reviewerToken);
  expect(
    (await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE)?.httpOnly,
  ).toBe(true);

  await page.goto(queuePath);
  await expect(page.getByRole("heading", { name: "Your review queue", level: 1 })).toBeVisible();
  await expect(page.getByText("Community review round")).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
  await expect(page.getByText("Organizer console", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Applicant portal", { exact: false })).toHaveCount(0);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to review content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#review-main$/u);
  await expectNoHighImpactAccessibilityViolations(page);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalDocumentOverflow(page);
  }

  await page.getByRole("link", { name: "Open assignment" }).click();
  await expect(page).toHaveURL(new RegExp(`${assignmentPath}$`, "u"));
  await expect(page.getByRole("heading", { name: "Independent proposal review" })).toBeVisible();
  await expect(page.getByText(fixture.safeSummary)).toBeVisible();
  let rendered = await page.content();
  expect(rendered).not.toContain(fixture.sourceEmail);
  expect(rendered).not.toContain(fixture.sourceName);
  expect(rendered).not.toContain(fixture.sourceHistory);
  expect(rendered).not.toContain("Source applicant email");
  expect(rendered).not.toContain("Source applicant name");

  const conflictControls = page.getByRole("region", {
    name: "Declare a conflict before reviewing",
  });
  const conflictDisclosure = conflictControls.locator("details");
  await conflictDisclosure.locator("summary").click();
  await expect(conflictDisclosure).toHaveAttribute("open", "");
  const conflictReason = conflictControls.getByLabel("Why is this a conflict?");
  await expect(conflictReason).toBeVisible();
  await conflictReason.fill(
    "Prior collaboration could affect independent judgment.",
  );
  await conflictControls
    .getByRole("button", { name: "Declare conflict and withhold content" })
    .click();
  await expect(page.getByText(fixture.safeSummary)).toHaveCount(0);
  await expect(page.getByTestId("conflict-blocked-assignment")).toBeVisible();
  rendered = await page.content();
  expect(rendered).not.toContain(fixture.safeSummary);
  expect(rendered).not.toContain("Proposal quality");
  expect(rendered).not.toContain(fixture.sourceEmail);
  expect(rendered).not.toContain(fixture.sourceName);

  await page
    .getByLabel("Why can this conflict be cleared?")
    .fill("The collaboration ended and no material conflict remains.");
  await page.getByRole("button", { name: "Clear conflict and refresh" }).click();
  await expect(page.getByTestId("reviewer-assignment")).toBeVisible();
  await expect(page.getByText(fixture.safeSummary)).toBeVisible();
  rendered = await page.content();
  expect(rendered).not.toContain(fixture.sourceEmail);
  expect(rendered).not.toContain(fixture.sourceName);
  expect(rendered).not.toContain(fixture.sourceHistory);

  await page.getByLabel("Proposal quality").fill("4");
  await page.getByLabel("Independent recommendation").selectOption("ADVANCE");
  await page.getByLabel("Reviewer notes").fill("Strong independent proposal evidence.");
  await page.getByRole("button", { name: "Save new revision" }).click();
  const firstReceipt = page.locator(".review-receipt");
  await expect(firstReceipt).toContainText("Review revision");
  await expect(firstReceipt).toContainText("Complete");
  await expect(firstReceipt).toContainText("In progress");
  await expect(firstReceipt).toContainText("Proposal revision sequence");
  await expect(firstReceipt).toContainText("Rubric version");
  await expect(
    firstReceipt.locator(".review-meta-list > div").filter({ hasText: "Review revision" }),
  ).toContainText("1");

  await page.reload();
  await expect(
    page.locator(".review-binding .review-meta-list > div").filter({
      hasText: "Latest review revision",
    }),
  ).toContainText("1");
  await expect(page.getByLabel("Reviewer notes")).toHaveValue(
    "Strong independent proposal evidence.",
  );
  appendConcurrentReviewerRevision(fixture);

  await page.getByLabel("Reviewer notes").fill("Unsaved browser reconciliation evidence.");
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.locator(".review-feedback[role='alert']")).toContainText(
    "explicitly reconcile",
  );
  await expect(page.getByLabel("Reviewer notes")).toHaveValue(
    "Unsaved browser reconciliation evidence.",
  );
  await expect(page.getByRole("link", { name: "Reload authoritative review" })).toBeVisible();
  await page.getByRole("link", { name: "Reload authoritative review" }).click();
  await expect(page.getByLabel("Reviewer notes")).toHaveValue(
    "Concurrent authoritative evidence.",
  );
  await expect(
    page.locator(".review-binding .review-meta-list > div").filter({
      hasText: "Latest review revision",
    }),
  ).toContainText("2");

  await page.getByLabel("Proposal quality").fill("5");
  await page.getByLabel("Independent recommendation").selectOption("ADVANCE");
  await page.getByLabel("Reviewer notes").fill("Reconciled final evidence.");
  await page.getByLabel("Reviewer notes").press("Control+s");
  const finalSaveReceipt = page.locator(".review-receipt");
  await expect(
    finalSaveReceipt.locator(".review-meta-list > div").filter({ hasText: "Review revision" }),
  ).toContainText("3");
  await expectNoHighImpactAccessibilityViolations(page);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalDocumentOverflow(page);
  }

  await page.getByRole("button", { name: "Submit saved review permanently" }).click();
  const terminalReceipt = page.locator(".review-receipt");
  await expect(terminalReceipt).toContainText("Submitted");
  await expect(terminalReceipt).toContainText("Complete");
  await expect(
    terminalReceipt.locator(".review-meta-list > div").filter({ hasText: "Review revision" }),
  ).toContainText("3");
  await expect(page.getByRole("button", { name: "Save new revision" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Submit saved review permanently" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".review-receipt")).toContainText("Submitted");
  await expect(page.getByRole("button", { name: "Save new revision" })).toHaveCount(0);
  rendered = await page.content();
  expect(rendered).not.toContain(fixture.sourceEmail);
  expect(rendered).not.toContain(fixture.sourceName);
  expect(rendered).not.toContain(fixture.sourceHistory);

  await useWorkspaceSession(context, origin, fixture.otherReviewerToken);
  await page.goto(assignmentPath);
  await expect(page.getByRole("heading", { name: "Review unavailable" })).toBeVisible();
  await expect(page.getByText(fixture.safeSummary)).toHaveCount(0);

  await page.goto(
    `/review/${fixture.workspaceSlug}/assignments/${encodeURIComponent("nonexistent-review")}`,
  );
  await expect(page.getByRole("heading", { name: "Review unavailable" })).toBeVisible();
  await expect(page.getByText(fixture.safeSummary)).toHaveCount(0);

  await useWorkspaceSession(context, origin, fixture.organizerToken);
  await page.goto(assignmentPath);
  await expect(page.getByRole("heading", { name: "Review unavailable" })).toBeVisible();
  await expect(page.getByText(fixture.safeSummary)).toHaveCount(0);

  await useWorkspaceSession(context, origin, fixture.reviewerToken);
  await page.goto(`/review/acme/assignments/${fixture.assignmentId}`);
  await expect(page.getByRole("heading", { name: "Review unavailable" })).toBeVisible();
  await expect(page.getByText(fixture.safeSummary)).toHaveCount(0);
});

test("reviewer fixture exposes only its D2 own-queue and blind-detail projections", () => {
  const fixture = createReviewerFixture();
  const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
  try {
    const session = resolveSession(db, fixture.reviewerToken);
    if (!session) throw new Error("missing reviewer fixture session");
    const queue = listOwnReviewAssignments(db, session, {
      workspaceSlug: fixture.workspaceSlug,
    });
    const assignment = queue.find((item) => item.assignmentId === fixture.assignmentId);
    expect(assignment).toBeDefined();
    const detail = readOwnReviewAssignment(db, session, {
      workspaceSlug: fixture.workspaceSlug,
      assignmentId: fixture.assignmentId,
    });
    const renderedProjection = JSON.stringify({ assignment, detail });
    expect(renderedProjection).toContain(fixture.safeSummary);
    expect(renderedProjection).not.toContain(fixture.sourceEmail);
    expect(renderedProjection).not.toContain(fixture.sourceName);
    expect(renderedProjection).not.toContain(fixture.sourceHistory);
  } finally {
    closeDb(db);
  }
});
