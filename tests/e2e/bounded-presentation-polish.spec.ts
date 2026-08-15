import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

const VIEWPORTS = [
  { width: 1440, height: 1000, label: "desktop" },
  { width: 390, height: 844, label: "narrow" },
] as const;

function monitor(page: Page, failures: string[]): void {
  page.on("pageerror", (error) => failures.push(`pageerror ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
    }
  });
}

async function expectNoDocumentOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => {
        const rectangle = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          right: Math.round(rectangle.right),
          width: Math.round(rectangle.width),
        };
      })
      .filter((entry) => entry.right > document.documentElement.clientWidth + 1)
      .slice(0, 6),
  }));
  expect(
    dimensions.scrollWidth,
    `${label} overflow: ${JSON.stringify(dimensions.offenders)}`,
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function capture(page: Page, filename: string): Promise<void> {
  const directory = process.env.SYMPOSE_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, filename), fullPage: true });
}

async function expectHumanTime(time: Locator): Promise<void> {
  const machine = await time.getAttribute("datetime");
  const visible = (await time.innerText()).trim();
  expect(machine).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(visible).not.toBe(machine);
  expect(visible).not.toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(visible).toContain(" · ");
}

async function visitAtBothViewports(
  page: Page,
  input: {
    readonly name: string;
    readonly path: string;
    readonly marker: (page: Page) => Locator;
    readonly assertSurface: (page: Page) => Promise<void>;
  },
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto(input.path);
    await expect(input.marker(page)).toBeVisible({ timeout: 20_000 });
    await input.assertSurface(page);
    await expectNoDocumentOverflow(page, `${input.name} ${viewport.label}`);
    await capture(page, `${input.name}-${viewport.label}.png`);
  }
}

async function signInAsOrganizer(page: Page): Promise<{
  readonly eventRoot: string;
  readonly personPath: string;
}> {
  await page.goto("/");
  const organizer = page.locator("label.login-option")
    .filter({ hasText: "Acme Organizer" })
    .getByRole("radio");
  await organizer.check();
  await page.getByRole("button", { name: "Sign in to workspace", exact: true }).click();
  await page.waitForURL(/\/w\/[^/]+\/dashboard$/u);
  const programHref = await page.getByRole("link", { name: "Program builder", exact: true })
    .getAttribute("href");
  const personHref = await page.locator(".dash__person-link").first().getAttribute("href");
  if (!programHref || !personHref) throw new Error("Organizer continuity links are unavailable");
  return { eventRoot: programHref.replace(/\/program$/u, ""), personPath: personHref };
}

test("bounded polish stays truthful, compact, reachable, and reflowable", async ({ browser }) => {
  test.setTimeout(420_000);
  const failures: string[] = [];

  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  monitor(reviewerPage, failures);

  await visitAtBothViewports(reviewerPage, {
    name: "landing",
    path: "/",
    marker: (page) => page.getByTestId("landing-sealed-at"),
    assertSurface: async (page) => {
      await expectHumanTime(page.getByTestId("landing-sealed-at"));
      await page.getByRole("button", { name: "Enter reviewer queue", exact: true }).focus();
      await expect(page.getByRole("button", { name: "Enter reviewer queue", exact: true })).toBeFocused();
    },
  });

  await reviewerPage.getByRole("button", { name: "Enter reviewer queue", exact: true }).click();
  await reviewerPage.waitForURL(/\/review\/[^/]+\/queue$/u);
  const reviewerQueuePath = new URL(reviewerPage.url()).pathname;
  await visitAtBothViewports(reviewerPage, {
    name: "reviewer-queue",
    path: reviewerQueuePath,
    marker: (page) => page.getByTestId("reviewer-queue"),
    assertSurface: async (page) => {
      const cards = page.locator(".review-queue-card");
      await expect(cards.first()).toBeVisible();
      await expect(cards.first().locator(".review-queue-card__round")).toContainText(/^Blind proposal 1 of \d+ · /u);
      await expect(cards.first().locator(".review-queue-card__position")).toBeHidden();
      const geometry = await cards.first().evaluate((element) => {
        const style = getComputedStyle(element);
        return { minHeight: style.minHeight, rootMinHeight: getComputedStyle(element.closest(".review-root")!).minHeight };
      });
      expect(geometry).toEqual({ minHeight: "0px", rootMinHeight: "0px" });
      const link = cards.first().getByRole("link", { name: "Open assignment", exact: true });
      const href = await link.getAttribute("href");
      expect(href).toMatch(/^\/review\/[^/]+\/assignments\/[^/]+$/u);
      await link.focus();
      await expect(link).toBeFocused();
    },
  });
  const assignmentLink = reviewerPage.getByRole("link", { name: "Open assignment", exact: true }).first();
  const assignmentHref = await assignmentLink.getAttribute("href");
  if (!assignmentHref) throw new Error("Authorized assignment link is unavailable");
  await assignmentLink.click();
  await reviewerPage.waitForURL(assignmentHref);
  await expect(reviewerPage.getByTestId("reviewer-assignment")).toBeVisible();
  await expectNoDocumentOverflow(reviewerPage, "reviewer assignment narrow smoke");
  await reviewerContext.close();

  const organizerContext = await browser.newContext();
  const organizerPage = await organizerContext.newPage();
  monitor(organizerPage, failures);
  const { eventRoot, personPath } = await signInAsOrganizer(organizerPage);
  const fullPersonId = decodeURIComponent(personPath.split("/").at(-1) ?? "");
  const displayPersonReference = fullPersonId.length > 18
    ? `${fullPersonId.slice(0, 8)}…${fullPersonId.slice(-6)}`
    : fullPersonId;

  await visitAtBothViewports(organizerPage, {
    name: "person",
    path: personPath,
    marker: (page) => page.getByTestId("person-provenance"),
    assertSurface: async (page) => {
      const record = page.getByTestId("person-provenance");
      await expect(record.getByTestId("person-display-reference")).toHaveText(displayPersonReference);
      await expect(record.locator(":scope > header")).not.toContainText(fullPersonId);
      const evidence = record.getByTestId("person-full-identifier");
      const summary = evidence.locator("summary");
      await summary.focus();
      await expect(summary).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(evidence).toHaveAttribute("open", "");
      await expect(evidence.locator("code")).toHaveText(fullPersonId);
      await page.keyboard.press("Enter");
      await expect(evidence).not.toHaveAttribute("open", "");
    },
  });

  await visitAtBothViewports(organizerPage, {
    name: "organizer-review",
    path: `${eventRoot}/review`,
    marker: (page) => page.getByTestId("selected-proposal-detail"),
    assertSurface: async (page) => {
      await expect(page.getByText("Proposal references are abbreviated for scanning", { exact: false })).toBeVisible();
      const detail = page.getByTestId("selected-proposal-detail");
      const fullSubmissionId = await detail.getAttribute("data-selected-submission-id");
      const code = detail.locator("header p code").first();
      expect((await code.textContent())?.trim()).toBe(fullSubmissionId);
      const clipping = await code.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          overflow: style.overflow,
          textOverflow: style.textOverflow,
          userSelect: style.userSelect,
          clipped: element.scrollWidth > element.clientWidth,
        };
      });
      expect(clipping).toEqual({ overflow: "hidden", textOverflow: "ellipsis", userSelect: "all", clipped: true });
      const gaps = detail.getByTestId("decision-intelligence-evidence-gaps");
      const summary = gaps.locator("summary");
      expect((await gaps.boundingBox())!.height).toBeLessThan(90);
      await summary.focus();
      await expect(summary).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(gaps).toHaveAttribute("open", "");
      await expect(gaps.getByText("No submitted evaluation evidence is available.", { exact: true })).toBeVisible();
      await expect(gaps.getByText("No canonical advocacy evidence", { exact: true })).toBeVisible();
      await expect(gaps.getByText("Proposal revision seal", { exact: true })).toBeVisible();
      await expect(gaps.getByText("Named program objectives", { exact: true })).toBeVisible();
      await expect(gaps.getByText("Displaced alternatives", { exact: true })).toBeVisible();
      await expect(gaps.getByText("Aggregate authority", { exact: true })).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(gaps).not.toHaveAttribute("open", "");
    },
  });

  await visitAtBothViewports(organizerPage, {
    name: "operations",
    path: `${eventRoot}/operations`,
    marker: (page) => page.getByTestId("operator-proof-experience"),
    assertSurface: async (page) => {
      const times = page.getByTestId("operator-proof-experience").locator("time");
      expect(await times.count()).toBeGreaterThan(0);
      for (let index = 0; index < await times.count(); index += 1) {
        await expectHumanTime(times.nth(index));
        await expect(times.nth(index)).toContainText("UTC");
      }
      const disclosure = page.getByText("Inspect technical release lineage", { exact: true });
      await disclosure.focus();
      await expect(disclosure).toBeFocused();
    },
  });

  await visitAtBothViewports(organizerPage, {
    name: "publication",
    path: `${eventRoot}/publication`,
    marker: (page) => page.getByTestId("publication-console"),
    assertSurface: async (page) => {
      await expectHumanTime(page.getByTestId("publication-sealed-at"));
      const lineage = page.locator("details").filter({ hasText: "Inspect immutable release lineage" });
      const summary = lineage.locator("summary");
      await summary.focus();
      await expect(summary).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(lineage).toHaveAttribute("open", "");
      await expectHumanTime(page.getByTestId("publication-lineage-sealed-at"));
      await page.keyboard.press("Enter");
      await expect(lineage).not.toHaveAttribute("open", "");
    },
  });

  expect(failures).toEqual([]);
  await organizerContext.close();
});
