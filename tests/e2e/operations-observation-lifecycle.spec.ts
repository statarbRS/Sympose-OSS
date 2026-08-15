import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

type BrowserHealth = {
  readonly serverErrors: string[];
  readonly pageErrors: string[];
};

const CORRECTION_REASON = "x".repeat(280);
const OBSERVED_AT = "2027-09-16T10:15:00.000Z";
const RECORDED_AT = "2027-09-16T10:30:00.000Z";
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DATABASE_PATH = resolve(".tmp/e2e/sympose.db");
const CLOCK_PATH = resolve(".tmp/e2e/server-clock.txt");

function setDevFlowLifecycle(eventId: string, lifecycle: "planning" | "live"): void {
  if (!existsSync(DATABASE_PATH)) return;
  const db = new DatabaseSync(DATABASE_PATH);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const result = db.prepare(
      `UPDATE events SET lifecycle = ?
       WHERE id = ? AND workspace_id = (SELECT id FROM workspaces WHERE slug = 'devflow')`,
    ).run(lifecycle, eventId);
    expect(result.changes).toBe(1);
  } finally {
    db.close();
  }
}

test.afterEach(async ({ page }) => {
  rmSync(CLOCK_PATH, { force: true });
  const match = new URL(page.url()).pathname.match(/^\/w\/devflow\/events\/([^/]+)\//u);
  if (match?.[1]) setDevFlowLifecycle(match[1], "planning");
});

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

async function signInAndResolveOperationsPath(page: Page): Promise<string> {
  await page.context().clearCookies();
  await page.goto("/");
  const organizer = page
    .locator("label.login-option")
    .filter({ hasText: "Jordan Alvarez" })
    .getByRole("radio");
  await expect(organizer).toBeVisible();
  await organizer.check();
  await Promise.all([
    page.waitForURL(/\/w\/devflow\/dashboard$/u, { timeout: 20_000 }),
    page.getByRole("button", { name: "Sign in to workspace", exact: true }).click(),
  ]);

  const speakerLink = page.getByRole("link", { name: "Check speakers", exact: true });
  await expect(speakerLink).toBeVisible();
  const href = await speakerLink.getAttribute("href");
  if (!href) throw new Error("DevFlow speaker link has no href.");
  const speakerPath = new URL(href, "http://sympose.test").pathname;
  if (!/^\/w\/devflow\/events\/[^/]+\/speakers$/u.test(speakerPath)) {
    throw new Error(`Unexpected DevFlow speaker path: ${speakerPath}`);
  }
  return speakerPath.replace(/\/speakers$/u, "/operations");
}

async function submitForResult(
  page: Page,
  operationsPath: string,
  button: Locator,
  resultCode: string,
  expectedMessage: string,
): Promise<void> {
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await Promise.all([
    page.waitForURL(
      (url) => url.pathname === operationsPath && url.searchParams.get("attendanceResult") === resultCode,
      { timeout: 20_000, waitUntil: "domcontentloaded" },
    ),
    button.click(),
  ]);
  expect(new URL(page.url()).searchParams.get("attendanceReceipt")).toMatch(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u,
  );
  await expect(page.getByTestId("attendance-action-result")).toHaveText(expectedMessage);
}

async function requiredAttribute(locator: Locator, attribute: string): Promise<string> {
  const value = await locator.getAttribute(attribute);
  if (!value) throw new Error(`Expected ${attribute} on locator.`);
  return value;
}

async function expectTouchTarget(locator: Locator, label: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `${label} has no rendered box`).not.toBeNull();
  expect(box!.height, `${label} is shorter than 44px`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${label} is narrower than 44px`).toBeGreaterThanOrEqual(44);
  await locator.click({ trial: true });
}

async function expectNoSurfaceOverflow(locator: Locator, label: string): Promise<void> {
  const dimensions = await locator.evaluate((root) => {
    const rootBox = root.getBoundingClientRect();
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      offenders: [...root.querySelectorAll<HTMLElement>("*")]
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className.slice(0, 100) : "",
          left: Math.round(box.left),
          right: Math.round(box.right),
          width: Math.round(box.width),
        };
      })
      .filter((entry) => entry.left < rootBox.left - 1 || entry.right > rootBox.right + 1)
      .slice(0, 8),
    };
  });
  expect(
    dimensions.scrollWidth,
    `${label} overflow: ${JSON.stringify(dimensions.offenders)}`,
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

test("DevFlow attendance preserves one-shot correction lineage across retries and reload", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  writeFileSync(CLOCK_PATH, `${RECORDED_AT}\n`, { encoding: "utf8", mode: 0o600 });

  const health = monitorBrowserHealth(page);
  const operationsPath = await signInAndResolveOperationsPath(page);
  const eventId = operationsPath.split("/")[4];
  if (!eventId) throw new Error("The DevFlow operations path has no event ID.");

  await page.goto(operationsPath);
  await expect(page.getByTestId("operations-observation-surface").getByText(
    "New attendance opens only while this event is live and within its event-time window.",
    { exact: true },
  )).toBeVisible();
  await expect(page.locator('[data-testid^="record-attendance-"]')).toHaveCount(0);

  setDevFlowLifecycle(eventId, "live");
  await page.goto(operationsPath);
  await expect(page.getByRole("heading", { name: "From proposal to event day", level: 1 })).toBeVisible();

  const surface = page.getByTestId("operations-observation-surface");
  const timeline = page.getByTestId("operations-timeline");
  const recordButton = surface.locator('[data-testid^="record-attendance-"]');
  const lineage = surface.locator('[data-testid^="attendance-lineage-"]');

  await expect(surface.getByText("Priya Raman", { exact: true })).toHaveCount(1);
  await expect(surface.getByText("Building calm developer systems", { exact: true })).toBeVisible();
  await expect(surface.getByText("Marcus Okafor", { exact: true })).toHaveCount(0);
  await expect(recordButton).toHaveCount(1);
  await expect(recordButton).toHaveText("Record attended");
  await expect(lineage).toHaveCount(0);
  await expect(surface.getByText(
    "No live-operations attendance has been recorded for this event.",
    { exact: true },
  )).toBeVisible();

  const occurrenceInput = surface.getByLabel("Occurrence time (UTC ISO 8601)", { exact: true });
  await occurrenceInput.fill(OBSERVED_AT);
  await submitForResult(
    page,
    operationsPath,
    recordButton,
    "record-created",
    "The attendance receipt is present in durable operational history.",
  );
  await expect(lineage).toHaveCount(1);
  await expect(lineage.locator('[data-kind="original"]')).toContainText("Original · attended");
  await expect(lineage.locator('[data-kind="original"] [data-state="current"]')).toHaveText("current");
  await expect(lineage.locator('[data-kind="correction"]')).toHaveCount(0);
  await expect(recordButton).toHaveText("Retry attendance");

  const originalTimes = lineage.locator('[data-kind="original"] time');
  await expect(originalTimes).toHaveCount(2);
  const originalObservedAt = await requiredAttribute(originalTimes.first(), "datetime");
  const originalRecordedAt = await requiredAttribute(originalTimes.nth(1), "datetime");
  expect(originalObservedAt).toMatch(ISO_INSTANT);
  expect(originalObservedAt).toBe(OBSERVED_AT);
  expect(originalRecordedAt).toBe(RECORDED_AT);
  expect(originalObservedAt).not.toBe(originalRecordedAt);
  await expect(timeline.locator('li[data-stage="operational"]')).toHaveCount(1);
  await expect(timeline.getByRole("heading", { name: "Attendance observed", exact: true })).toHaveCount(1);

  await occurrenceInput.fill(OBSERVED_AT);
  await submitForResult(
    page,
    operationsPath,
    recordButton,
    "record-replayed",
    "The attendance receipt remains the one durable observation; no duplicate exists.",
  );
  await expect(lineage).toHaveCount(1);
  await expect(timeline.locator('li[data-stage="operational"]')).toHaveCount(1);
  expect(await requiredAttribute(lineage.locator('[data-kind="original"] time').first(), "datetime"))
    .toBe(originalObservedAt);

  await lineage.getByLabel("Correction reason", { exact: true }).fill(CORRECTION_REASON);
  const correctionButton = lineage.locator('[data-testid^="correct-attendance-"]');
  await submitForResult(
    page,
    operationsPath,
    correctionButton,
    "correction-created",
    "The correction receipt is present; the original remains visible and superseded.",
  );

  const originalRow = lineage.locator('[data-kind="original"]');
  const correctionRow = lineage.locator('[data-kind="correction"]');
  await expect(lineage).toHaveCount(1);
  await expect(originalRow).toContainText("Original · attended");
  await expect(originalRow.locator('[data-state="superseded"]')).toHaveText("superseded");
  await expect(correctionRow).toHaveCount(1);
  await expect(correctionRow).toContainText("Correction · did not attend");
  await expect(correctionRow.getByText(CORRECTION_REASON, { exact: true })).toBeVisible();
  await expect(correctionRow).toContainText("Jordan Alvarez · organizer ·");
  await expect(correctionRow.locator('[data-state="current"]')).toHaveText("current");

  const correctionTimes = correctionRow.locator("time");
  await expect(correctionTimes).toHaveCount(2);
  const correctionObservedAt = await requiredAttribute(correctionTimes.first(), "datetime");
  const correctionRecordedAt = await requiredAttribute(correctionTimes.nth(1), "datetime");
  expect(correctionObservedAt).toMatch(ISO_INSTANT);
  expect(correctionObservedAt > originalObservedAt).toBe(true);
  expect(correctionRecordedAt).toBe(correctionObservedAt);
  expect(await requiredAttribute(originalRow.locator("time").first(), "datetime")).toBe(originalObservedAt);

  await expect(timeline.locator('li[data-stage="operational"]')).toHaveCount(2);
  await expect(timeline.getByRole("heading", {
    name: "Attendance originally observed — superseded",
    exact: true,
  })).toHaveCount(1);
  await expect(timeline.getByRole("heading", {
    name: "Attendance corrected: did not attend",
    exact: true,
  })).toHaveCount(1);
  await expect(timeline.getByText("observations · observation_corrections", { exact: true })).toHaveCount(2);
  await expect(timeline.getByText(`${CORRECTION_REASON.slice(0, 120)}…`, { exact: false }).first())
    .toBeVisible();

  await expect(lineage.getByLabel("Exact-retry reason", { exact: true })).toHaveValue(CORRECTION_REASON);
  await expect(correctionButton).toHaveText("Retry correction");
  await submitForResult(
    page,
    operationsPath,
    correctionButton,
    "correction-replayed",
    "The correction receipt remains the one durable lineage; no duplicate exists.",
  );
  await expect(lineage).toHaveCount(1);
  await expect(originalRow).toHaveCount(1);
  await expect(correctionRow).toHaveCount(1);
  await expect(timeline.locator('li[data-stage="operational"]')).toHaveCount(2);
  expect(await requiredAttribute(originalRow.locator("time").first(), "datetime")).toBe(originalObservedAt);
  expect(await requiredAttribute(correctionRow.locator("time").first(), "datetime")).toBe(correctionObservedAt);

  await page.goto(operationsPath);
  await expect(page.getByTestId("attendance-action-result")).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "From proposal to event day", level: 1 })).toBeVisible();
  await expect(lineage).toHaveCount(1);
  await expect(originalRow.locator('[data-state="superseded"]')).toHaveText("superseded");
  await expect(correctionRow.locator('[data-state="current"]')).toHaveText("current");
  await expect(correctionRow.getByText(CORRECTION_REASON, { exact: true })).toBeVisible();
  await expect(correctionRow).toContainText("Jordan Alvarez · organizer ·");
  expect(await requiredAttribute(originalRow.locator("time").first(), "datetime")).toBe(originalObservedAt);
  expect(await requiredAttribute(correctionRow.locator("time").first(), "datetime")).toBe(correctionObservedAt);
  await expect(timeline.locator('li[data-stage="operational"]')).toHaveCount(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame())));
  const retryAttendance = surface.getByRole("button", { name: "Retry attendance", exact: true });
  const retryCorrection = surface.getByRole("button", { name: "Retry correction", exact: true });
  await expectTouchTarget(retryAttendance, "mobile attendance retry");
  await expectTouchTarget(retryCorrection, "mobile correction retry");
  await retryCorrection.focus();
  await expect(retryCorrection).toBeFocused();
  await expectNoSurfaceOverflow(surface, "Attendance surface");
  await expectNoSurfaceOverflow(timeline, "Operations timeline");

  const accessibility = await new AxeBuilder({ page })
    .include('[data-testid="operations-observation-surface"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    accessibility.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? "")),
    "Operations observation surface has serious or critical Axe findings",
  ).toEqual([]);
  expect(health.serverErrors).toEqual([]);
  expect(health.pageErrors).toEqual([]);
});
