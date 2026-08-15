import { expect, test, type Locator, type Page } from "@playwright/test";

type BrowserHealth = {
  readonly serverErrors: string[];
  readonly pageErrors: string[];
};

function monitorBrowserHealth(page: Page): BrowserHealth {
  const health: BrowserHealth = { serverErrors: [], pageErrors: [] };
  page.on("response", (response) => {
    if (response.status() >= 500) {
      health.serverErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on("pageerror", (error) => {
    health.pageErrors.push(error.message);
  });
  return health;
}

async function openOrganizerSpeakerSurface(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Evaluator persona entry points", level: 2 }),
  ).toBeVisible();

  const organizerChoice = page
    .locator("label.login-option")
    .filter({ hasText: "Acme Organizer" })
    .getByRole("radio");
  await organizerChoice.check();
  await page.getByRole("button", { name: "Sign in to workspace", exact: true }).click();
  await page.waitForURL((url) => /^\/w\/[^/]+\/dashboard$/u.test(url.pathname));

  const speakerLink = page.getByRole("link", { name: "Speaker surface", exact: true });
  await expect(speakerLink).toBeVisible();
  const href = await speakerLink.getAttribute("href");
  if (!href) throw new Error("The visible Speaker surface link has no destination");
  const destination = new URL(href, "http://sympose.test").pathname;
  await Promise.all([
    page.waitForURL((url) => url.pathname === destination),
    speakerLink.click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 }),
  ).toBeVisible();
}

async function returnToOrganizerSpeakerSurface(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForURL((url) => /^\/w\/[^/]+\/dashboard$/u.test(url.pathname));
  const speakerLink = page.getByRole("link", { name: "Speaker surface", exact: true });
  await expect(speakerLink).toBeVisible();
  const href = await speakerLink.getAttribute("href");
  if (!href) throw new Error("The visible Speaker surface link has no destination");
  const destination = new URL(href, "http://sympose.test").pathname;
  await Promise.all([
    page.waitForURL((url) => url.pathname === destination),
    speakerLink.click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 }),
  ).toBeVisible();
}

function rosterTable(page: Page): Locator {
  return page.getByRole("table", {
    name: "Canonical people with event-scoped speaker and moderator projections",
  });
}

function rosterRow(page: Page, fullName: string): Locator {
  return rosterTable(page).locator("tbody tr").filter({ hasText: fullName }).first();
}

async function openMinaPreview(page: Page): Promise<void> {
  const mina = rosterRow(page, "Mina Park");
  await expect(mina).toContainText("Mina Park");
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/speaker"),
    mina.getByRole("button", { name: "Open local preview", exact: true }).click(),
  ]);
  await expect(page.getByRole("heading", { name: "Welcome, Mina Park", level: 1 })).toBeVisible();
}

async function closePortalAndReturn(page: Page): Promise<void> {
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/speaker/entry"),
    page.getByRole("button", { name: "Close portal", exact: true }).click(),
  ]);
  await returnToOrganizerSpeakerSurface(page);
}

async function submitCurrentPageAction(page: Page, button: Locator): Promise<void> {
  const actionPath = new URL(page.url()).pathname;
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => candidate.request().method() === "POST" && new URL(candidate.url()).pathname === actionPath,
    ),
    button.click(),
  ]);
  expect(response.ok()).toBe(true);
}

function taskSection(page: Page): Locator {
  return page.locator('section[aria-labelledby="tasks-title"]');
}

function progressText(section: Locator): Locator {
  return section.getByText(/^\d+ \/ \d+ complete$/u).first();
}

test.describe("speaker and content browser evidence", () => {
  test.setTimeout(90_000);

  test("keeps speaker scope, task progress, content history, and reminder evidence visible", async ({ page }) => {
    const health = monitorBrowserHealth(page);

    await page.goto("/");
    await openOrganizerSpeakerSurface(page);

    const speakerPath = new URL(page.url()).pathname;
    const routeWorkspace = speakerPath.split("/")[2];
    const contentExportForm = page.locator('form[id^="content-export-"]');
    const contentExportAction = await contentExportForm.getAttribute("action");
    const contentExportHref = await page
      .getByRole("link", { name: "Download all content metadata", exact: true })
      .getAttribute("href");
    expect(routeWorkspace).toBe("acme");
    expect(contentExportAction).not.toBeNull();
    expect(contentExportHref).not.toBeNull();
    expect(new URL(contentExportAction!, "http://sympose.test").pathname.split("/")[2]).toBe(routeWorkspace);
    expect(new URL(contentExportHref!, "http://sympose.test").pathname.split("/")[2]).toBe(routeWorkspace);

    const search = page.locator('input[name="q"]');
    await search.fill("Mina Park");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("q") === "Mina Park");
    await expect(rosterTable(page).locator("tbody tr")).toHaveCount(1);
    await expect(rosterRow(page, "Mina Park")).toBeVisible();

    await page.getByRole("link", { name: "Clear", exact: true }).click();
    await page.waitForURL((url) => url.pathname.endsWith("/speakers") && !url.searchParams.has("q"));
    await expect(rosterTable(page).locator("tbody tr")).toHaveCount(1);

    await expect(
      page.getByRole("heading", { name: "Create an individual speaker task", level: 2 }),
    ).toBeVisible();
    const createTask = page.getByRole("button", {
      name: "Create task and assign speaker",
      exact: true,
    });
    const taskRequest = createTask.locator("xpath=ancestor::form[1]");
    await taskRequest.locator('select[name="personId"]').selectOption({ label: "Mina Park · MODERATOR" });
    await taskRequest.locator('select[name="taskTemplate"]').selectOption("PROFILE");
    await taskRequest.locator('input[name="title"]').fill("Profile and public bio");
    await taskRequest.locator('input[name="dueAt"]').fill("2026-09-12T17:00");
    await taskRequest.locator('select[name="gate"]').selectOption("CONFIRMATION");
    await taskRequest
      .locator('textarea[name="description"]')
      .fill("Confirm the reusable profile and event-facing override.");
    await taskRequest.locator('input[name="required"]').check();
    await createTask.click();
    const profileWork = page
      .getByRole("table", { name: "Per-speaker task state, deadline, exact version, and file metadata" })
      .locator("tbody tr")
      .filter({ hasText: "Profile and public bio" });
    await expect(profileWork).toContainText("NOT_STARTED");

    await taskRequest.locator('select[name="personId"]').selectOption({ label: "Mina Park · MODERATOR" });
    await taskRequest.locator('select[name="taskTemplate"]').selectOption("BRIEFING");
    await taskRequest.locator('input[name="title"]').fill("Briefing attendance");
    await taskRequest.locator('input[name="dueAt"]').fill("2026-09-12T17:00");
    await taskRequest.locator('select[name="gate"]').selectOption("");
    await taskRequest
      .locator('textarea[name="description"]')
      .fill("Confirm attendance at the local speaker briefing.");
    await taskRequest.locator('input[name="required"]').uncheck();
    await createTask.click();
    const briefingWork = page
      .getByRole("table", { name: "Per-speaker task state, deadline, exact version, and file metadata" })
      .locator("tbody tr")
      .filter({ hasText: "Briefing attendance" });
    await expect(briefingWork).toContainText("NOT_STARTED");

    await openMinaPreview(page);
    await expect(page.getByText("Organizer support preview", { exact: true })).toBeVisible();
    await expect(page.getByText("Organizer planning details and other people are not exposed.", { exact: false })).toBeVisible();
    await expect(page.getByText("Bruno Silva", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Cass Nguyen", { exact: true })).toHaveCount(0);

    const tasks = taskSection(page);
    await expect(tasks).toBeVisible();
    const beforeProgress = await progressText(tasks).innerText();
    const briefing = tasks.locator("article").filter({ hasText: "Briefing attendance" }).first();
    await expect(briefing.getByRole("button", { name: "Mark complete", exact: true })).toBeVisible();
    await briefing.getByRole("button", { name: "Mark complete", exact: true }).click();
    await expect(briefing).toContainText("COMPLETED");
    const afterProgress = await progressText(tasks).innerText();
    expect(afterProgress).not.toBe(beforeProgress);
    await expect(page.locator('section[aria-labelledby="readiness-title"]')).toContainText(/Ready|Action needed/u);

    const profile = page.locator('section[aria-labelledby="profile-title"]');
    const revisedBio = "Browser evidence biography for Mina Park.";
    const currentTitle = await profile.getByLabel("Public title", { exact: true }).inputValue();
    const revisedTitle = `${currentTitle} · Browser evidence`;
    await profile.getByLabel("Bio", { exact: true }).fill(revisedBio);
    await profile.getByLabel("Public title", { exact: true }).fill(revisedTitle);
    await submitCurrentPageAction(
      page,
      profile.getByRole("button", { name: "Submit profile revision", exact: true }),
    );
    await expect(profile).toContainText("Pending revision");

    await closePortalAndReturn(page);

    const minaAfterProfile = rosterRow(page, "Mina Park");
    await minaAfterProfile.getByText("Profile, session, and task controls", { exact: true }).click();
    await expect(minaAfterProfile.getByLabel("Public title", { exact: true })).toHaveValue(revisedTitle);
    const persistedBriefing = page
      .getByRole("table", { name: "Per-speaker task state, deadline, exact version, and file metadata" })
      .locator("tbody tr")
      .filter({ hasText: "Briefing attendance" });
    await expect(persistedBriefing).toContainText("COMPLETED");

    await expect(minaAfterProfile.getByRole("button", { name: "Send reminder", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("action-task-reminder-scheduler")).toContainText("PENDING outbox only");
    await expect(page.getByTestId("action-task-reminder-provider-boundary")).toContainText("No SMTP or provider is contacted.");

    await openMinaPreview(page);
    const sessionTask = taskSection(page).locator("article").filter({ hasText: "Session title" }).first();
    const submitSessionVersion = sessionTask.getByRole("button", {
      name: "Submit new immutable version",
      exact: true,
    });
    await sessionTask.getByLabel("Title", { exact: true }).fill("Responsible Systems in Practice · browser version 2");
    await submitCurrentPageAction(page, submitSessionVersion);
    const portalReview = page.locator('section[aria-labelledby="review-history-title"]');
    const sessionHistory = portalReview.locator("li").filter({ hasText: "SESSION_TITLE" }).first();
    await expect(sessionHistory).toContainText("Version 1");
    await expect(sessionHistory).toContainText("Version 2");
    await sessionTask.getByLabel("Title", { exact: true }).fill("Responsible Systems in Practice · browser version 3");
    await submitCurrentPageAction(page, submitSessionVersion);
    await expect(sessionHistory).toContainText("Version 3");

    await closePortalAndReturn(page);
    const reviewCard = page
      .getByRole("heading", { name: "Mina Park · Session title", exact: true, level: 3 })
      .locator("xpath=ancestor::article[1]");
    await expect(reviewCard).toBeVisible();
    await expect(reviewCard).toContainText("Version 1");
    await expect(reviewCard).toContainText("Version 2");
    await expect(reviewCard).toContainText("Version 3");

    await reviewCard.getByLabel("Comment", { exact: true }).fill("Browser evidence review");
    await submitCurrentPageAction(
      page,
      reviewCard.getByRole("button", { name: "Add comment", exact: true }),
    );
    await expect(reviewCard).toContainText("Comment · Browser evidence review");

    const approve = reviewCard.getByRole("button", { name: "Approve exact version", exact: true });
    await expect(approve).toBeEnabled();
    await submitCurrentPageAction(page, approve);
    const versionThree = reviewCard.locator("li").filter({ hasText: "Version 3" }).first();
    await expect(versionThree.getByText("APPROVED", { exact: true })).toBeVisible();

    const versionOne = reviewCard.locator("ol > li").filter({ hasText: "Version 1" }).first();
    await versionOne.locator("details").first().locator(":scope > summary").click();
    const restore = versionOne.getByRole("button", { name: "Restore as new version", exact: true });
    await expect(restore).toBeVisible();
    await submitCurrentPageAction(page, restore);
    await expect(reviewCard).toContainText("Version 4");

    expect(health.serverErrors, "unexpected 5xx responses").toEqual([]);
    expect(health.pageErrors, "unexpected browser page errors").toEqual([]);
  });
});
