import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

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

async function signInAndOpenSpeakerOperations(page: Page): Promise<string> {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Evaluator persona entry points", level: 2 }),
  ).toBeVisible({ timeout: 20_000 });
  await page
    .locator("label.login-option")
    .filter({ hasText: "Acme Organizer" })
    .getByRole("radio")
    .check();
  await page.getByRole("button", { name: "Sign in to workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/dashboard$/u, { timeout: 20_000 });

  const speakerLink = page.getByRole("link", { name: "Speaker surface", exact: true });
  const href = await speakerLink.getAttribute("href");
  expect(href).not.toBeNull();
  await speakerLink.click();
  await expect(
    page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 }),
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  return new URL(href!, "http://sympose.test").pathname;
}

async function expectNoSeriousAxeViolations(page: Page, surface: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = result.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target),
    }));
  expect(violations, `${surface} has critical or serious Axe violations`).toEqual([]);
}

async function expectNoPageOverflow(page: Page, surface: string): Promise<void> {
  const widths = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.right <= viewport + 0.5 && rect.left >= -0.5) return false;
        for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
          const overflow = getComputedStyle(ancestor).overflowX;
          if (["auto", "scroll", "hidden", "clip"].includes(overflow)) return false;
        }
        return true;
      })
      .slice(0, 12)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: element.className,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          text: (element.textContent ?? "").trim().replace(/\s+/gu, " ").slice(0, 80),
        };
      });
    return {
      viewport,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      offenders,
    };
  });
  const evidence = JSON.stringify(widths.offenders);
  expect(widths.document, `${surface} document overflows horizontally; candidates: ${evidence}`).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body, `${surface} body overflows horizontally; candidates: ${evidence}`).toBeLessThanOrEqual(widths.viewport);
}

async function expectActionInsideViewport(page: Page, action: Locator, label: string): Promise<void> {
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeVisible();
  const box = await action.boundingBox();
  expect(box, `${label} has no rendered box`).not.toBeNull();
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box!.x, `${label} begins outside the viewport`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label} ends outside the viewport`).toBeLessThanOrEqual(viewportWidth);
}

function rosterTable(page: Page): Locator {
  return page.getByRole("table", {
    name: "Canonical people with event-scoped speaker and moderator projections",
  });
}

async function captureViewport(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(name), animations: "disabled" });
}

test.describe("speaker and content fast-scanning UX", () => {
  test.setTimeout(90_000);

  test("keeps attention, routine work, evidence, empty, and unavailable states clear on desktop", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const health = monitorBrowserHealth(page);
    const speakerPath = await signInAndOpenSpeakerOperations(page);

    await expect(page.getByRole("heading", { name: "Needs attention", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Speaker work queue", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deliverables work queue", level: 2 })).toBeVisible();
    await expect(page.getByText("Setup and intake", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Content submissions and approvals", level: 2 })).toBeVisible();
    await page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 }).scrollIntoViewIfNeeded();
    await captureViewport(page, testInfo, "speaker-operations-desktop-overview.png");

    const firstRosterRow = rosterTable(page).locator("tbody tr").first();
    await expect(firstRosterRow.getByRole("button", { name: /invitation/iu })).toBeVisible();
    await expect(firstRosterRow.getByRole("button", { name: "Open local preview", exact: true })).toBeVisible();
    await firstRosterRow.getByText("Profile, session, and task controls", { exact: true }).click();
    await expect(firstRosterRow.getByRole("button", { name: "Save status", exact: true })).toBeVisible();
    await firstRosterRow.getByText("Exact assignment and delivery evidence", { exact: true }).click();
    await expect(firstRosterRow.getByText("Terms fingerprint", { exact: true })).toBeVisible();
    const openedReviewVersion = page
      .locator('section[aria-labelledby="content-review-title"] article')
      .first()
      .locator("details[open]")
      .first();
    await expect(openedReviewVersion.locator("summary").getByText("Latest", { exact: true })).toBeVisible();
    await expect(openedReviewVersion.getByText("Approval evidence", { exact: true })).toBeVisible();
    await expectNoPageOverflow(page, "Speaker Operations desktop");
    await expectNoSeriousAxeViolations(page, "Speaker Operations desktop");
    await captureViewport(page, testInfo, "speaker-operations-desktop.png");

    const search = page.locator('input[name="q"]');
    await search.fill("No matching speaker 999");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect(page).toHaveURL(/q=No(?:\+|%20)matching(?:\+|%20)speaker(?:\+|%20)999/u);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("No authorized speakers match the current filters.", { exact: true })).toBeVisible();
    await expect(page.getByText("No speaker tasks match the current authorized roster filters.", { exact: true })).toBeVisible();
    await expect(page.getByText("No assigned speakers are available in this view.", { exact: false })).toBeVisible();
    const readinessEvidence = page.getByText("Readiness evidence and activity", { exact: true });
    await readinessEvidence.click();
    await expect(page.getByText("No assigned speakers are available for readiness evaluation in this view.", { exact: true })).toBeVisible();
    await expectNoPageOverflow(page, "Speaker Operations filtered empty state");
    await expectNoSeriousAxeViolations(page, "Speaker Operations filtered empty state");
    await readinessEvidence.click();

    await page.getByRole("link", { name: "Clear", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === speakerPath && !url.searchParams.has("q"));
    await expect(page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.getByRole("link", { name: "Open Content Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Speaker files and immutable versions", level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Content requiring review", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Current file work queue", level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download selected latest files (.zip)", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^Select current /u }).first()).toBeVisible();
    const immutableEvidence = page.getByText("Immutable version evidence", { exact: true });
    await immutableEvidence.click();
    const evidenceTable = page.getByRole("table", { name: "Persisted speaker artifact versions" });
    await expect(evidenceTable).toBeVisible();
    await expect(evidenceTable.getByRole("columnheader", { name: "Exact hashes", exact: true })).toBeVisible();
    await expect(evidenceTable.locator("code").first()).toBeVisible();
    await expectNoPageOverflow(page, "Content Library desktop");
    await expectNoSeriousAxeViolations(page, "Content Library desktop");
    await page.getByRole("heading", { name: "Content requiring review", level: 2 }).scrollIntoViewIfNeeded();
    await captureViewport(page, testInfo, "content-library-desktop.png");
    await immutableEvidence.click();

    const workspace = speakerPath.split("/")[2];
    const unavailable = await page.goto(`/w/${workspace}/events/not-a-real-event/speakers`);
    expect([200, 404], "Next may stream a not-found boundary with HTTP 200").toContain(unavailable?.status());
    await expect(page.getByRole("heading", { name: "This surface is unavailable", level: 1 })).toBeVisible();
    await expect(page.getByText("The requested workspace or event cannot be disclosed.", { exact: false })).toBeVisible();
    await expectNoSeriousAxeViolations(page, "Speaker Operations unavailable state");

    expect(health.serverErrors, "unexpected 5xx responses").toEqual([]);
    expect(health.pageErrors, "unexpected browser page errors").toEqual([]);
  });

  test("keeps organizer actions in the 390px work flow without page overflow", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const health = monitorBrowserHealth(page);
    await signInAndOpenSpeakerOperations(page);

    await expectNoPageOverflow(page, "Speaker Operations at 390px");
    const rosterRegion = page.getByRole("region", { name: "Speaker roster table" });
    const rosterWidths = await rosterRegion.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    expect(rosterWidths.scroll, "mobile roster actions require horizontal table scrolling").toBeLessThanOrEqual(rosterWidths.client);

    const firstRosterRow = rosterTable(page).locator("tbody tr").first();
    await expectActionInsideViewport(page, firstRosterRow.getByRole("button", { name: /invitation/iu }), "mobile invitation action");
    await expectActionInsideViewport(page, firstRosterRow.getByRole("button", { name: "Open local preview", exact: true }), "mobile portal preview action");
    await firstRosterRow.getByText("Profile, session, and task controls", { exact: true }).click();
    await expectActionInsideViewport(page, firstRosterRow.getByRole("button", { name: "Save status", exact: true }), "mobile workflow action");
    await captureViewport(page, testInfo, "speaker-operations-mobile-actions.png");
    await expectNoSeriousAxeViolations(page, "Speaker Operations at 390px");

    await page.getByRole("link", { name: "Open Content Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Speaker files and immutable versions", level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expectNoPageOverflow(page, "Content Library at 390px");
    await expectActionInsideViewport(page, page.getByRole("button", { name: "Download selected latest files (.zip)", exact: true }), "mobile ZIP action");
    await expectActionInsideViewport(page, page.getByRole("checkbox", { name: /^Select current /u }).first(), "mobile current-file selection");
    await captureViewport(page, testInfo, "content-library-mobile-work.png");
    await expectNoSeriousAxeViolations(page, "Content Library at 390px");

    expect(health.serverErrors, "unexpected 5xx responses").toEqual([]);
    expect(health.pageErrors, "unexpected browser page errors").toEqual([]);
  });
});
