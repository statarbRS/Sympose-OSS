import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { createSession, SESSION_COOKIE, type SessionInfo } from "../../src/server/auth";
import { fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  createOrganizerReviewRound,
  createOrganizerReviewRubric,
  distributeOrganizerReviewAssignments,
  readOrganizerReviewSurface,
  setOrganizerReviewRoundState,
} from "../../src/server/services/cfp-review/organizer";
import {
  saveOwnReview,
  submitOwnReview,
} from "../../src/server/services/cfp-review/reviewer";
import {
  createCall,
  createDraftSubmission,
  createFormDefinition,
  saveDraftRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";

type ReviewFirstFixture = Readonly<{
  eventId: string;
  roundId: string;
  organizerToken: string;
  primarySubmissionId: string;
  secondarySubmissionId: string;
  primaryApplicant: string;
  secondaryApplicant: string;
}>;

type SubmissionFixture = Readonly<{
  submissionId: string;
  submissionRevisionId: string;
  applicantName: string;
}>;

function createSubmittedProposal(
  db: Db,
  input: {
    readonly workspaceId: string;
    readonly callId: string;
    readonly suffix: string;
    readonly slot: number;
    readonly applicantName: string;
    readonly organization: string;
    readonly proposal: string;
  },
): SubmissionFixture {
  const personId = randomUUID();
  const verificationId = randomUUID();
  const applicantSessionId = randomUUID();
  const email = `review-first-${input.slot}-${input.suffix}@synthetic.example`;
  const createdAt = `2026-08-13T0${input.slot}:00:00.000Z`;

  db.prepare(
    `INSERT INTO people
       (id, workspace_id, canonical_email, full_name, organization, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    personId,
    input.workspaceId,
    email,
    input.applicantName,
    input.organization,
    createdAt,
  );
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, '2099-09-01T00:00:00.000Z', ?)`,
  ).run(
    verificationId,
    input.workspaceId,
    input.callId,
    email,
    fingerprintOf({ fixture: input.suffix, slot: input.slot, kind: "verification" }),
    createdAt,
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), input.workspaceId, verificationId, personId, createdAt);
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id,
        token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '2099-09-01T00:00:00.000Z')`,
  ).run(
    applicantSessionId,
    input.workspaceId,
    input.callId,
    personId,
    verificationId,
    fingerprintOf({ fixture: input.suffix, slot: input.slot, kind: "session" }),
    createdAt,
  );
  const submission = createDraftSubmission(
    db,
    { workspaceId: input.workspaceId, sessionId: applicantSessionId },
    { callId: input.callId },
  );
  const revision = saveDraftRevision(
    db,
    { workspaceId: input.workspaceId, sessionId: applicantSessionId },
    {
      submissionId: submission.id,
      expectedCurrentRevisionId: null,
      historicalAnswers: [{ fieldId: "proposal", value: input.proposal }],
    },
  );
  db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(submission.id);
  return {
    submissionId: submission.id,
    submissionRevisionId: revision.revisionId,
    applicantName: input.applicantName,
  };
}

function submitProjectedReview(
  db: Db,
  input: {
    readonly workspaceSlug: string;
    readonly session: SessionInfo;
    readonly assignmentId: string;
    readonly recommendation: "ADVANCE" | "HOLD";
    readonly score: number;
    readonly suffix: string;
  },
): void {
  saveOwnReview(db, input.session, {
    workspaceSlug: input.workspaceSlug,
    assignmentId: input.assignmentId,
    expectedAssignmentStateSequenceNumber: 1,
    expectedReviewRevisionNumber: 0,
    evaluation: {
      schema: "cfp-review-evaluation/v1",
      responses: [
        { criterionId: "quality", value: input.score },
        { criterionId: "recommendation", value: input.recommendation },
        {
          criterionId: "notes",
          value: input.recommendation === "ADVANCE"
            ? "Strong evidence with a clear audience outcome."
            : "Promising evidence with an unresolved delivery question.",
        },
      ],
    },
    idempotencyKey: `review-first-save-${input.suffix}-${input.recommendation.toLowerCase()}`,
  });
  submitOwnReview(db, input.session, {
    workspaceSlug: input.workspaceSlug,
    assignmentId: input.assignmentId,
    expectedAssignmentStateSequenceNumber: 2,
    expectedReviewRevisionNumber: 1,
    idempotencyKey: `review-first-submit-${input.suffix}-${input.recommendation.toLowerCase()}`,
  });
}

function createReviewFirstFixture(): ReviewFirstFixture {
  const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
  try {
    const workspaceSlug = "northstar";
    const workspace = db.prepare(
      "SELECT id FROM workspaces WHERE slug = ?",
    ).get(workspaceSlug) as { id: string };
    const organizer = db.prepare(
      "SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' ORDER BY id LIMIT 1",
    ).get(workspace.id) as { id: string };
    const suffix = randomUUID().slice(0, 8);
    const reviewerIds = [`review-first-a-${suffix}`, `review-first-b-${suffix}`] as const;
    const reviewerNames = ["Avery Reviewer", "Blair Reviewer"] as const;
    const createdAt = "2026-08-13T00:00:00.000Z";

    for (const [index, reviewerId] of reviewerIds.entries()) {
      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES (?, ?, ?, ?, 'reviewer', ?)`,
      ).run(
        reviewerId,
        workspace.id,
        `${reviewerId}@synthetic.example`,
        reviewerNames[index],
        createdAt,
      );
    }

    const organizerSession = createSession(db, organizer.id, workspace.id);
    const reviewerSessions = new Map<string, SessionInfo>(
      reviewerIds.map((reviewerId) => [
        reviewerId,
        createSession(db, reviewerId, workspace.id).session,
      ]),
    );
    const eventId = randomUUID();
    db.prepare(
      `INSERT INTO events
         (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, 'Proposal-first browser proof', 'UTC', ?, ?, 'planning', ?)`,
    ).run(
      eventId,
      workspace.id,
      "2026-09-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      createdAt,
    );

    const organizerContext = { workspaceId: workspace.id, accountId: organizer.id };
    const definition = createFormDefinition(db, organizerContext, {
      name: `Proposal-first form ${suffix}`,
    });
    const form = sealFormVersion(db, organizerContext, {
      formDefinitionId: definition.id,
      fields: [{
        id: "proposal",
        type: "longText",
        label: "Proposal",
        required: true,
        defaultVisibility: "visible",
      }],
      rules: { schema: FORM_RULES_SCHEMA, rules: [] },
    });
    const call = createCall(db, organizerContext, {
      eventId,
      name: "Community program proposals",
      slug: `review-first-${suffix}`,
      formVersionId: form.id,
      state: "OPEN",
      timezone: "UTC",
      opensAt: "2026-08-01T00:00:00.000Z",
      closesAt: "2026-09-01T00:00:00.000Z",
      policy: {
        disclosure: {
          privacy: "Synthetic fixture privacy notice.",
          retention: "Synthetic fixture retention notice.",
          aiProcessing: "No AI processing is used in this fixture.",
          communication: "Synthetic fixture communication only.",
          consent: "Synthetic fixture consent only.",
          publication: "Synthetic fixture publication only.",
        },
        choices: [],
      },
    });
    const primary = createSubmittedProposal(db, {
      workspaceId: workspace.id,
      callId: call.id,
      suffix,
      slot: 1,
      applicantName: "Mina Chen",
      organization: "Open Assembly",
      proposal: "A practical session on resilient community programs.",
    });
    const secondary = createSubmittedProposal(db, {
      workspaceId: workspace.id,
      callId: call.id,
      suffix,
      slot: 2,
      applicantName: "Noah Williams",
      organization: "Civic Studio",
      proposal: "A facilitated workshop on inclusive event operations.",
    });

    const round = createOrganizerReviewRound(db, organizerSession.session, {
      workspaceSlug,
      eventId,
      callId: call.id,
      name: "Program committee review",
      opensAt: "2026-08-10T09:00:00.000Z",
      closesAt: "2026-08-25T17:00:00.000Z",
      idempotencyKey: `review-first-round-${suffix}`,
    });
    createOrganizerReviewRubric(db, organizerSession.session, {
      workspaceSlug,
      roundId: round.roundId,
      fields: [
        {
          id: "quality",
          label: "Proposal quality",
          kind: "numeric",
          required: true,
          weight: 2,
          minimum: 0,
          maximum: 10,
          step: 1,
        },
        {
          id: "recommendation",
          label: "Independent recommendation",
          kind: "dropdown",
          required: true,
          weight: 1,
          recommendation: true,
          choices: [
            { value: "ADVANCE", label: "Advance" },
            { value: "HOLD", label: "Hold" },
            { value: "DO_NOT_ADVANCE", label: "Do not advance" },
          ],
        },
        {
          id: "notes",
          label: "Evidence notes",
          kind: "text",
          required: false,
          weight: 1,
          maxLength: 500,
        },
      ],
    });
    distributeOrganizerReviewAssignments(db, organizerSession.session, {
      workspaceSlug,
      roundId: round.roundId,
      reviewerAccountIds: reviewerIds,
      submissionIds: [primary.submissionId, secondary.submissionId],
      reviewsPerSubmission: 2,
      maxAssignmentsPerReviewer: 2,
      blindArtifactDecisions: [primary, secondary].map((submission) => ({
        submissionId: submission.submissionId,
        submissionRevisionId: submission.submissionRevisionId,
        decisions: [{
          sourceFieldId: "proposal",
          action: "INCLUDE_REDACTED" as const,
          reviewLabel: "Blind proposal",
          redactedValue: `Blind-safe proposal evidence for ${submission.applicantName}.`,
        }],
      })),
    });
    setOrganizerReviewRoundState(db, organizerSession.session, {
      workspaceSlug,
      roundId: round.roundId,
      expectedStateSequenceNumber: 1,
      state: "OPEN",
      reason: "Open the proposal-first browser proof round.",
    });

    const surface = readOrganizerReviewSurface(db, organizerSession.session, {
      workspaceSlug,
      eventId,
      roundId: round.roundId,
    });
    const primaryAssignments = surface.rounds[0]?.assignments.filter(
      (assignment) => assignment.submissionId === primary.submissionId,
    ) ?? [];
    if (primaryAssignments.length !== 2) {
      throw new Error("Proposal-first fixture did not create two primary assignments");
    }
    for (const [index, assignment] of primaryAssignments.entries()) {
      const reviewerSession = reviewerSessions.get(assignment.reviewerAccountId);
      if (!reviewerSession) throw new Error("Proposal-first fixture lost a reviewer session");
      submitProjectedReview(db, {
        workspaceSlug,
        session: reviewerSession,
        assignmentId: assignment.id,
        recommendation: index === 0 ? "ADVANCE" : "HOLD",
        score: index === 0 ? 9 : 6,
        suffix: `${suffix}-${index}`,
      });
    }

    return {
      eventId,
      roundId: round.roundId,
      organizerToken: organizerSession.token,
      primarySubmissionId: primary.submissionId,
      secondarySubmissionId: secondary.submissionId,
      primaryApplicant: primary.applicantName,
      secondaryApplicant: secondary.applicantName,
    };
  } finally {
    closeDb(db);
  }
}

async function useOrganizerSession(
  context: BrowserContext,
  page: Page,
  token: string,
): Promise<void> {
  await page.goto("/");
  await context.addCookies([{
    name: SESSION_COOKIE,
    value: token,
    url: new URL(page.url()).origin,
    httpOnly: true,
    sameSite: "Lax",
  }]);
}

async function expectNoSeriousAxeDefects(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = result.violations.filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? ""),
  );
  console.info(`review-first axe ${label}: serious=${serious.length}`);
  expect(serious, `${label} has critical or serious Axe violations`).toEqual([]);
}

async function expectReviewHierarchy(page: Page, viewportHeight: number): Promise<void> {
  const hierarchy = await page.evaluate(() => {
    const primary = document.querySelector<HTMLElement>('[data-testid="proposal-review-workspace"]');
    const detail = document.querySelector<HTMLElement>('[data-testid="selected-proposal-detail"]');
    const setup = document.querySelector<HTMLElement>('[data-testid="review-secondary-setup"]');
    if (!primary || !detail || !setup) throw new Error("Review hierarchy is incomplete");
    const primaryRect = primary.getBoundingClientRect();
    const detailRect = detail.getBoundingClientRect();
    const setupRect = setup.getBoundingClientRect();
    return {
      primaryTop: primaryRect.top,
      detailTop: detailRect.top,
      setupTop: setupRect.top,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(hierarchy.primaryTop).toBeLessThan(hierarchy.setupTop);
  expect(hierarchy.detailTop).toBeLessThan(hierarchy.setupTop);
  expect(hierarchy.primaryTop).toBeLessThan(viewportHeight);
  expect(hierarchy.scrollWidth).toBeLessThanOrEqual(hierarchy.clientWidth);
}

test("proposal evidence dominates organizer review before secondary Setup at desktop and 390px", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = createReviewFirstFixture();
  const evidenceDirectory = resolve(".tmp/browser-evidence");
  mkdirSync(evidenceDirectory, { recursive: true });
  await useOrganizerSession(context, page, fixture.organizerToken);
  const route = `/w/northstar/events/${fixture.eventId}/review?round=${encodeURIComponent(fixture.roundId)}`;

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(route);
  const proposalWorkspace = page.getByTestId("proposal-review-workspace");
  const selectedDetail = page.getByTestId("selected-proposal-detail");
  const setup = page.getByTestId("review-secondary-setup");
  await expect(proposalWorkspace.getByRole("heading", { name: "Unresolved proposals" })).toBeVisible();
  await expect(selectedDetail).toHaveAttribute("data-selected-submission-id", fixture.primarySubmissionId);
  await expect(selectedDetail.getByText("Reviewer disagreement", { exact: false })).toBeVisible();
  const reviewerEvidence = selectedDetail.getByRole("region", { name: "Reviewer evidence" });
  await expect(reviewerEvidence.getByRole("heading", { name: "Reviewer evidence" })).toBeVisible();
  await expect(reviewerEvidence.getByText("Avery Reviewer", { exact: true })).toBeVisible();
  await expect(reviewerEvidence.getByText("Blair Reviewer", { exact: true })).toBeVisible();
  await expect(setup.locator("details").first()).not.toHaveAttribute("open", "");

  const secondaryButton = proposalWorkspace
    .getByTestId("proposal-queue-item")
    .filter({ hasText: fixture.secondaryApplicant });
  await secondaryButton.click();
  await expect(secondaryButton).toBeFocused();
  await expect(secondaryButton).toHaveAttribute("aria-pressed", "true");
  await expect(selectedDetail).toHaveAttribute("data-selected-submission-id", fixture.secondarySubmissionId);
  await expect(selectedDetail.getByRole("heading", { name: fixture.secondaryApplicant })).toBeVisible();
  await proposalWorkspace
    .getByTestId("proposal-queue-item")
    .filter({ hasText: fixture.primaryApplicant })
    .click();

  await expectReviewHierarchy(page, 1000);
  await expectNoSeriousAxeDefects(page, "desktop");
  await page.screenshot({
    path: resolve(evidenceDirectory, "review-first-desktop-1440.png"),
  });
  await page.screenshot({
    path: resolve(evidenceDirectory, "review-first-desktop-1440-full.png"),
    fullPage: true,
  });
  const setupDisclosure = setup.locator("details").first();
  const setupSummary = setupDisclosure.locator("summary").first();
  await setupSummary.click();
  await expect(setupDisclosure).toHaveAttribute("open", "");
  await expectNoSeriousAxeDefects(page, "desktop-setup-open");
  await setupSummary.click();
  await expect(setupDisclosure).not.toHaveAttribute("open", "");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const mobileSelect = proposalWorkspace.getByLabel("Proposal to inspect");
  await expect(mobileSelect).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectReviewHierarchy(page, 844);
  await mobileSelect.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await mobileSelect.focus();
  await expect(mobileSelect).toBeFocused();
  const selectorOcclusion = await mobileSelect.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const mobileNavigation = document.querySelector<HTMLElement>(
      'nav[aria-label="Mobile workspace navigation"]',
    );
    const topmost = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      top: rect.top,
      bottom: rect.bottom,
      navigationTop: mobileNavigation?.getBoundingClientRect().top ?? window.innerHeight,
      hitTarget: topmost === element || element.contains(topmost),
    };
  });
  console.info(
    `review-first mobile selector: top=${selectorOcclusion.top.toFixed(1)} bottom=${selectorOcclusion.bottom.toFixed(1)} navTop=${selectorOcclusion.navigationTop.toFixed(1)}`,
  );
  expect(selectorOcclusion.top).toBeGreaterThanOrEqual(0);
  expect(selectorOcclusion.bottom).toBeLessThanOrEqual(selectorOcclusion.navigationTop);
  expect(selectorOcclusion.hitTarget, "The focused mobile proposal selector is occluded").toBe(true);
  await mobileSelect.selectOption(fixture.secondarySubmissionId);
  await expect(selectedDetail).toHaveAttribute("data-selected-submission-id", fixture.secondarySubmissionId);
  await expect(selectedDetail.getByRole("heading", { name: fixture.secondaryApplicant })).toBeVisible();
  await mobileSelect.selectOption(fixture.primarySubmissionId);
  await expect(selectedDetail.getByText("Reviewer disagreement", { exact: false })).toBeVisible();
  await expect(setup.locator("details").first()).not.toHaveAttribute("open", "");
  await expectNoSeriousAxeDefects(page, "mobile-390");
  await page.screenshot({
    path: resolve(evidenceDirectory, "review-first-mobile-390.png"),
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  const mobileDocumentHeight = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  await page.setViewportSize({ width: 390, height: mobileDocumentHeight });
  await page.screenshot({
    path: resolve(evidenceDirectory, "review-first-mobile-390-full.png"),
  });
});
