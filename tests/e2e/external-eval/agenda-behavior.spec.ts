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
  page.on("pageerror", (error) => health.pageErrors.push(error.message));
  return health;
}

async function assertBrowserHealth(health: BrowserHealth): Promise<void> {
  expect(health.serverErrors, "unexpected 5xx responses").toEqual([]);
  expect(health.pageErrors, "unexpected browser errors").toEqual([]);
}

async function selectRenderedOption(select: Locator, text: string): Promise<void> {
  const option = select.locator("option").filter({ hasText: text }).first();
  await expect(option, `missing rendered option containing ${text}`).toBeAttached();
  const value = await option.getAttribute("value");
  expect(value, `rendered option ${text} has no value`).toBeTruthy();
  await select.selectOption(value!);
}

async function ensureConfigurationOpen(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /room and track controls$/u });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function signInAsOrganizer(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Evaluator persona entry points", level: 2 }),
  ).toBeVisible();

  const organizerChoice = page
    .locator("label.login-option")
    .filter({ hasText: "Acme Organizer" })
    .getByRole("radio");
  await expect(organizerChoice).toBeVisible();
  await organizerChoice.check();
  await page.getByRole("button", { name: "Sign in to workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/dashboard$/u, { timeout: 20_000 });
}

test("organizer moves, publishes, and compares the accepted agenda in a browser", async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(20_000);
  const health = monitorBrowserHealth(page);

  await signInAsOrganizer(page);

  const programLink = page.getByRole("link", { name: "Program builder", exact: true });
  await expect(programLink).toBeVisible();
  await Promise.all([
    page.waitForURL(/\/w\/[^/]+\/events\/[^/]+\/program$/u),
    programLink.click(),
  ]);
  await expect(page.getByRole("heading", { name: "Plan Studio", level: 1 })).toBeVisible();

  // Configure one additional room and track through the organizer controls.
  await ensureConfigurationOpen(page);
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  await page.getByRole("button", { name: "Add track", exact: true }).click();

  const roomNames = page.locator('input[id^="room-name-"]');
  const roomCapacities = page.locator('input[id^="room-capacity-"]');
  const trackNames = page.locator('input[id^="track-name-"]');
  await roomNames.last().fill("Workshop Annex");
  await roomCapacities.last().fill("96");
  await trackNames.last().fill("Workshop Track");
  await page.getByTestId("save-schedule-configuration").click();
  await expect(page.getByTestId("schedule-builder-result")).toContainText(
    "Saved room and track configuration",
  );

  // Continuity supplies exactly the durably accepted program unit to the scheduler.
  await expect(page.getByText("1", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("of 1 total", { exact: true })).toBeVisible();
  await expect(page.getByText("No hard speaker or room overlaps are present in this draft.", { exact: true })).toBeVisible();

  // This is the accessible, visible equivalent of dragging the accepted session to a cell.
  const placementSession = page.locator("#placement-session");
  await selectRenderedOption(placementSession, "Trustworthy Evaluation Keynote");
  await selectRenderedOption(page.locator("#placement-room"), "Workshop Annex");
  await selectRenderedOption(page.locator("#placement-track"), "Workshop Track");
  await expect(page.getByTestId("direct-placement-control")).toHaveText("Move session");
  await page.getByTestId("direct-placement-control").click();
  await expect(page.getByTestId("schedule-builder-result")).toContainText("Moved");
  await expect(
    page.getByText("No hard speaker or room overlaps are present in this draft.", { exact: true }),
  ).toBeVisible();

  // Every accepted session is already placed; no unaccepted fixture session enters the draft.
  const autoSchedule = page.getByTestId("auto-schedule-control");
  await expect(autoSchedule).toBeDisabled();
  await expect(page.getByText("0 in tray", { exact: true })).toBeVisible();
  await expect(page.getByText("The unscheduled tray is empty.", { exact: true })).toBeVisible();

  // Confirm the durable draft survives a full page reload, including resources and moves.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Plan Studio", level: 1 })).toBeVisible();
  await expect(page.getByText("0 in tray", { exact: true })).toBeVisible();
  await expect(
    page.getByText("No hard speaker or room overlaps are present in this draft.", { exact: true }),
  ).toBeVisible();
  await ensureConfigurationOpen(page);
  await expect(roomNames.last()).toHaveValue("Workshop Annex");
  await expect(trackNames.last()).toHaveValue("Workshop Track");

  // The edit made the initial fixture approval stale. Organizer authority is a separate,
  // explicit exact-revision decision before publication becomes available.
  const approveSchedule = page.getByTestId("approve-schedule-draft");
  await expect(approveSchedule).toBeEnabled();
  await approveSchedule.click();
  await expect(page.getByTestId("schedule-approval-receipt")).toContainText("revision 3");
  await expect(page.getByTestId("approve-schedule-draft")).toHaveText("Exact revision approved");

  // Seal the persisted browser draft and follow the visible public handoff.
  await Promise.all([
    page.waitForURL(/\/w\/[^/]+\/events\/[^/]+\/publication$/u),
    page.getByTestId("publication-handoff-link").click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Current durable event projection", level: 1 }),
  ).toBeVisible({ timeout: 20_000 });
  const releasePointer = page.getByTestId("durable-current-release").locator("code");
  const priorReleaseId = (await releasePointer.innerText()).trim();
  await page.getByText("Validate current authoritative inputs", { exact: true }).click();
  await page.getByRole("button", { name: "Check and seal exact current inputs", exact: true }).click();
  await expect(
    page.getByText("The approved plan was sealed as the event's durable current release.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("publication-seal-receipt")).toBeVisible();
  await page.getByRole("link", { name: "Review current release", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Current durable event projection", level: 1 })).toBeVisible();
  await expect.poll(async () => (await releasePointer.innerText()).trim()).not.toBe(priorReleaseId);
  const currentReleaseId = (await releasePointer.innerText()).trim();
  const organizerRelease = await page.getByTestId("organizer-source-release").innerText();
  const releaseFingerprint = organizerRelease.match(/[a-f0-9]{64}/u)?.[0];
  expect(releaseFingerprint).toBeTruthy();

  const publicAgendaLink = page.getByRole("link", { name: "Open current public agenda", exact: true });
  const publicAgendaHref = await publicAgendaLink.getAttribute("href");
  expect(publicAgendaHref).toMatch(/^\/events\/aud1-[0-9a-f-]+\/agenda$/u);
  expect(publicAgendaHref).not.toContain(currentReleaseId);

  // A separate browser page acts as the attendee/public view while sharing only the
  // browser-persisted sealed release; no organizer service or token is used.
  const attendeePage = await page.context().newPage();
  const attendeeHealth = monitorBrowserHealth(attendeePage);
  try {
    await attendeePage.goto(publicAgendaHref!);
    await expect(attendeePage.getByRole("heading", { name: "Acme Evaluator Summit", level: 1 })).toBeVisible();
    await expect(attendeePage.getByTestId("public-source-release")).toHaveText(
      "This page reads the sealed audience projection; internal release identifiers are not shown.",
    );
    const publicSession = attendeePage
      .locator("article")
      .filter({ hasText: "Evaluating AI systems without losing the plot" })
      .first();
    await expect(publicSession).toBeVisible();
    await expect(publicSession).toContainText("Workshop Annex");
    await expect(publicSession).toContainText("Workshop Track");
    await expect(attendeePage.locator("body")).not.toContainText(currentReleaseId);
    await expect(attendeePage.locator("body")).not.toContainText(releaseFingerprint!);
  } finally {
    await assertBrowserHealth(attendeeHealth);
    await attendeePage.close();
  }

  await assertBrowserHealth(health);
});
