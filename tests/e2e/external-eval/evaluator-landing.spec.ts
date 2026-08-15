import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { closeDb, openDb } from "../../../src/server/db";
import { EVALUATOR_COMPATIBILITY_EVENT_ID } from "../../../src/server/evaluator-compatibility";
import { EVALUATOR_EVENT_ID, EVALUATOR_WORKSPACE_ID } from "../../../src/server/evaluator-demo";

const databasePath = resolve(process.env.SYMPOSE_DB_PATH ?? ".tmp/e2e/sympose.db");
const isolatedOrigin = process.env.EVALUATOR_LANDING_E2E_ORIGIN;
if (isolatedOrigin) test.use({ baseURL: isolatedOrigin });

const compatibilityFixture = JSON.parse(
  readFileSync(resolve("tests/fixtures/external-eval/devflow-compatibility.json"), "utf8"),
) as {
  profile: {
    workspaceSlug: string;
    workspaceName: string;
    callSlug: string;
    organizer: string;
    reviewer: string;
    applicantSpeakers: string[];
  };
};

test("root evaluator landing is discoverable and usable at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "See how proposals become a published event program." }),
  ).toBeVisible();
  await expect(page.getByText("Local synthetic fixture", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: compatibilityFixture.profile.workspaceName })).toBeVisible();
  await expect(page.getByText(compatibilityFixture.profile.organizer, { exact: true })).toBeVisible();
  await expect(
    page.getByText(compatibilityFixture.profile.applicantSpeakers.join(" · "), { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: compatibilityFixture.profile.reviewer })).toBeVisible();
  await expect(page.getByTestId("persona-chooser")).toBeVisible();
  await expect(page.getByTestId("devflow-compatibility-profile").locator("article")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Use the DevFlow organizer entry above", exact: true }),
  ).toHaveAttribute("href", "#workspace-entry");
  await expect(
    page.getByRole("link", { name: "Use the reviewer entry here", exact: true }),
  ).toHaveAttribute("href", "#reviewer-entry");
  await expect(page.getByTestId("attendee-agenda-status")).toContainText(
    "Attendee agenda available",
  );
  const attendeeAgendaLink = page.getByRole("link", {
    name: "Open current attendee agenda",
    exact: true,
  });
  await expect(attendeeAgendaLink).toHaveCount(1);
  await expect(attendeeAgendaLink).toHaveAttribute(
    "href",
    /^\/events\/aud1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/agenda$/u,
  );
  await expect(page.getByRole("heading", { name: "Evaluator persona entry points" })).toBeVisible();
  for (const role of ["Organizer", "Reviewer", "Applicant", "Speaker", "Attendee"]) {
    await expect(page.getByText(role, { exact: true }).first()).toBeVisible();
  }

  const visibleText = await page.locator("body").innerText();
  expect(visibleText.match(/synthetic/giu) ?? []).toHaveLength(1);

  const mobileGeometry = await page.evaluate(() => {
    const organizer = document.querySelector<HTMLElement>("#workspace-entry");
    const personaChooser = document.querySelector<HTMLElement>("[data-testid='persona-chooser']");
    const releaseRail = document.querySelector<HTMLElement>("[data-testid='hero-release-rail']");
    const undersizedControls = [...document.querySelectorAll<HTMLElement>("a, button, label:has(input)")]
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return { height: rect.height, width: rect.width };
      })
      .filter(({ height, width }) => height > 0 && (height < 44 || width < 44));
    return {
      organizerTop: organizer ? organizer.getBoundingClientRect().top + window.scrollY : null,
      sourceOrderBeforeRail: Boolean(
        personaChooser &&
          releaseRail &&
          (personaChooser.compareDocumentPosition(releaseRail) & Node.DOCUMENT_POSITION_FOLLOWING),
      ),
      undersizedControls,
    };
  });
  expect(mobileGeometry.organizerTop).not.toBeNull();
  expect(mobileGeometry.organizerTop!).toBeLessThanOrEqual(900);
  expect(mobileGeometry.sourceOrderBeforeRail).toBe(true);
  expect(mobileGeometry.undersizedControls).toEqual([]);

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

  const skipLink = page.getByRole("link", { name: "Skip to workspace entry" });
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();

  const startButton = page.getByRole("button", { name: "Start with an organizer workspace" });
  await page.keyboard.press("Tab");
  await expect(startButton).toBeFocused();
  const focusStyles = await startButton.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { outlineStyle: computed.outlineStyle, outlineWidth: computed.outlineWidth };
  });
  expect(focusStyles.outlineStyle).not.toBe("none");
  expect(focusStyles.outlineWidth).not.toBe("0px");

  await expect(
    page.locator("#organizer-login-form label.login-option").filter({ hasText: "Acme" }).locator("input:checked"),
  ).toHaveCount(1);
  await Promise.all([
    page.waitForURL(/\/w\/acme\/dashboard$/u, { timeout: 30_000 }),
    page.keyboard.press("Enter"),
  ]);
  const acmeEvaluatorSurfaces = page.getByRole("navigation", { name: "Evaluator surfaces" });
  await expect(acmeEvaluatorSurfaces).toBeVisible();
  await expect(acmeEvaluatorSurfaces.getByRole("link", { name: "Review surface", exact: true })).toHaveAttribute(
    "href",
    `/w/acme/events/${EVALUATOR_EVENT_ID}/review`,
  );
  const acmeEvaluatorHrefs = await acmeEvaluatorSurfaces.getByRole("link").evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute("href")),
  );
  expect(acmeEvaluatorHrefs.some((href) => href?.includes("devflow"))).toBe(false);

  await page.context().clearCookies();
  await page.goto("/");
  await Promise.all([
    page.waitForURL(/\/events\/aud1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/agenda$/u, {
      timeout: 30_000,
    }),
    attendeeAgendaLink.click(),
  ]);
  await expect(page.getByRole("heading", { name: "Acme Evaluator Summit", level: 1 })).toBeVisible();
});

test("landing keeps equal persona rows at evaluator desktop widths", async ({ page }) => {
  for (const width of [1440, 1120, 980]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");

    const cardRects = await page
      .getByTestId("persona-chooser")
      .locator("article")
      .evaluateAll((cards) =>
        cards.map((card) => {
          const rect = card.getBoundingClientRect();
          return { top: Math.round(rect.top), height: Math.round(rect.height) };
        }),
      );
    expect(cardRects).toHaveLength(5);
    const rows = Map.groupBy(cardRects, ({ top }) => top);
    expect(rows.size).toBe(2);
    for (const row of rows.values()) {
      expect(new Set(row.map(({ height }) => height)).size).toBe(1);
    }
  }
});

test("landing keeps the release rail unavailable when the current pointer is missing", async ({ page }) => {
  const db = openDb({ path: databasePath });
  const event = db
    .prepare("SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?")
    .get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as { currentReleaseId: string | null } | undefined;
  if (!event) throw new Error("The seeded attendee event is missing");

  try {
    db.prepare("UPDATE events SET current_release_id = NULL WHERE workspace_id = ? AND id = ?")
      .run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID);
    await page.goto("/");

    await expect(page.getByTestId("hero-release-rail")).toBeVisible();
    await expect(page.getByTestId("attendee-agenda-status")).toContainText(
      "Attendee agenda unavailable",
    );
    await expect(page.getByTestId("attendee-agenda-status")).toContainText(
      "No current sealed public release can be verified for this fixture.",
    );
    await expect(
      page.getByTestId("hero-release-rail").getByRole("heading", { name: "Sealed public release", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Show attendee availability", exact: true })).toHaveAttribute(
      "href",
      "#attendee-agenda-status",
    );
  } finally {
    db.prepare("UPDATE events SET current_release_id = ? WHERE workspace_id = ? AND id = ?")
      .run(event.currentReleaseId, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID);
    closeDb(db);
  }
});

test("DevFlow compatibility entries use the existing organizer, reviewer, and applicant mechanisms", async ({ page }) => {
  await page.goto("/");
  const organizerChoice = page
    .locator("label.login-option")
    .filter({ hasText: compatibilityFixture.profile.organizer })
    .getByRole("radio");
  await organizerChoice.check();
  await Promise.all([
    page.waitForURL(new RegExp(`/w/${compatibilityFixture.profile.workspaceSlug}/dashboard$`), {
      timeout: 30_000,
    }),
    page.getByRole("button", { name: "Sign in to workspace", exact: true }).click(),
  ]);
  await expect(page.getByText(compatibilityFixture.profile.workspaceName, { exact: true }).first()).toBeVisible();

  const devflowEvaluatorSurfaces = page.getByRole("navigation", { name: "Evaluator surfaces" });
  await expect(devflowEvaluatorSurfaces).toBeVisible();
  const devflowReviewSurface = devflowEvaluatorSurfaces.getByRole("link", {
    name: "Review surface",
    exact: true,
  });
  await expect(devflowReviewSurface).toHaveAttribute(
    "href",
    `/w/devflow/events/${EVALUATOR_COMPATIBILITY_EVENT_ID}/review`,
  );
  const devflowEvaluatorHrefs = await devflowEvaluatorSurfaces.getByRole("link").evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute("href")),
  );
  expect(devflowEvaluatorHrefs.some((href) => href?.includes("/w/acme/") || href?.includes(EVALUATOR_EVENT_ID))).toBe(false);
  await Promise.all([
    page.waitForURL(new RegExp(`/w/${compatibilityFixture.profile.workspaceSlug}/events/.+/review$`), {
      timeout: 30_000,
    }),
    devflowReviewSurface.click(),
  ]);
  await expect(page.getByTestId("reviewer-provisioning")).toBeVisible();
  await expect(page.getByTestId("reviewer-access-status")).toHaveText("Ready to provision");
  await page.getByTestId("reviewer-access-provision").click();
  await expect(page.getByTestId("reviewer-access-status")).toHaveText("provisioned");
  await page.getByTestId("reviewer-access-invite").click();
  await expect(page.getByTestId("reviewer-access-status")).toHaveText("invited");
  await page.getByTestId("reviewer-access-activate").click();
  await expect(page.getByTestId("reviewer-access-status")).toHaveText("active");
  await Promise.all([
    page.waitForURL(new RegExp(`/review/${compatibilityFixture.profile.workspaceSlug}/queue$`), {
      timeout: 30_000,
    }),
    page.getByTestId("reviewer-persona-transition").click(),
  ]);
  await expect(page.getByTestId("reviewer-queue")).toContainText("Your review queue");

  await page.context().clearCookies();
  await page.goto("/");
  const reviewerEntryLink = page.locator('a[href="#reviewer-entry"]');
  await expect(reviewerEntryLink).toBeVisible();
  await reviewerEntryLink.click();
  await expect(page.locator("#reviewer-entry")).toBeVisible();
  const reviewerChoice = page
    .locator('form[aria-label="Reviewer entry"] label')
    .filter({ hasText: compatibilityFixture.profile.reviewer })
    .getByRole("radio");
  await reviewerChoice.check();
  await Promise.all([
    page.waitForURL(new RegExp(`/review/${compatibilityFixture.profile.workspaceSlug}/queue$`), {
      timeout: 30_000,
    }),
    page.getByRole("button", { name: "Enter reviewer queue", exact: true }).click(),
  ]);
  await expect(page.getByTestId("reviewer-queue")).toContainText("Your review queue");

  await page.context().clearCookies();
  await page.goto("/");
  const applicantEntryLink = page.locator(
    `a[href="/cfp/${compatibilityFixture.profile.workspaceSlug}/${compatibilityFixture.profile.callSlug}"]`,
  );
  await expect(applicantEntryLink).toBeVisible();
  await Promise.all([
    page.waitForURL(
      new RegExp(`/cfp/${compatibilityFixture.profile.workspaceSlug}/${compatibilityFixture.profile.callSlug}$`),
      { timeout: 30_000 },
    ),
    applicantEntryLink.click(),
  ]);
  await expect(
    page.getByRole("heading", { name: `${compatibilityFixture.profile.workspaceName} Call for Proposals`, level: 1 }),
  ).toBeVisible();
});
