import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page, surface: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth, `${surface} overflows horizontally`).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectNoSeriousAxeViolations(page: Page, surface: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = result.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious",
  );
  expect(serious, `${surface} has critical or serious Axe violations`).toEqual([]);
}

async function expectMinimumTouchTarget(target: Locator, label: string): Promise<void> {
  const size = await target.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return { height: rectangle.height, width: rectangle.width };
  });
  expect(size.height, `${label} is shorter than 44px`).toBeGreaterThanOrEqual(44);
  expect(size.width, `${label} is narrower than 44px`).toBeGreaterThanOrEqual(44);
}

test("final UX release stays focused, bounded, and accessible at 1440 and 390", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const chooser = page.getByTestId("persona-chooser");
  await expect(chooser).toBeVisible();
  await expect(chooser.locator("article")).toHaveCount(5);
  await expect(page.getByTestId("devflow-compatibility-profile").locator("article")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Choose an organizer workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open public program", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open current attendee agenda", exact: true })).toBeVisible();
  const landingHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(landingHeight).toBeLessThan(3_400);
  await expectNoHorizontalOverflow(page, "mobile landing");
  await expectNoSeriousAxeViolations(page, "mobile landing");
  await page.screenshot({ path: testInfo.outputPath("landing-390.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectNoHorizontalOverflow(page, "desktop landing");
  await expectNoSeriousAxeViolations(page, "desktop landing");
  await page.screenshot({ path: testInfo.outputPath("landing-1440.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.locator("label.login-option input").first().check();
  await page.getByRole("button", { name: "Sign in to workspace", exact: true }).click();
  await page.waitForLoadState("networkidle");
  const overviewHref = await page.locator('a[href*="/events/"][href$="/overview"]').first().getAttribute("href");
  expect(overviewHref).not.toBeNull();
  await page.goto(overviewHref!);

  const mobileNavigation = page.getByRole("navigation", { name: "Mobile workspace navigation" });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.locator(":scope > a, :scope > details")).toHaveCount(4);
  await expect(mobileNavigation).toContainText("Home");
  await expect(mobileNavigation).toContainText("Events");
  await expect(mobileNavigation).toContainText("People");
  await expect(mobileNavigation).toContainText("More");
  const navGeometry = await mobileNavigation.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return {
      bottom: rectangle.bottom,
      position: getComputedStyle(element).position,
      top: rectangle.top,
      viewportHeight: window.innerHeight,
    };
  });
  expect(navGeometry.position).toBe("fixed");
  expect(navGeometry.bottom).toBeLessThanOrEqual(navGeometry.viewportHeight);
  expect(navGeometry.top).toBeGreaterThan(navGeometry.viewportHeight - 90);
  for (const label of ["Home", "Events", "People"]) {
    await expectMinimumTouchTarget(mobileNavigation.getByRole("link", { name: label, exact: true }), label);
  }
  const moreSummary = mobileNavigation.locator("summary");
  await expectMinimumTouchTarget(moreSummary, "More");
  await moreSummary.click();
  const moreDestinations = page.getByRole("group", { name: "More workspace destinations" });
  await expect(moreDestinations).toBeVisible();
  for (const label of ["Connectors", "Analytics", "Memory"]) {
    const destination = moreDestinations.getByRole("link", { name: label, exact: true });
    await expect(destination).toBeVisible();
    await expectMinimumTouchTarget(destination, label);
  }
  await moreSummary.click();

  const workflowNavigation = page.getByRole("navigation", { name: "Event workflow destinations" });
  const finalWorkflow = workflowNavigation.getByRole("link", { name: /Operations/u });
  await finalWorkflow.scrollIntoViewIfNeeded();
  const occlusion = await finalWorkflow.evaluate((element) => {
    const target = element.getBoundingClientRect();
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Mobile workspace navigation"]')
      ?.getBoundingClientRect();
    const hit = document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2);
    return {
      bottom: target.bottom,
      hit: hit === element || (hit !== null && element.contains(hit)),
      navigationTop: nav?.top ?? window.innerHeight,
    };
  });
  expect(occlusion.bottom).toBeLessThanOrEqual(occlusion.navigationTop);
  expect(occlusion.hit).toBe(true);
  await expect(page.locator('section[aria-labelledby="attention-title"] a')).toHaveCount(3);
  await expectNoHorizontalOverflow(page, "mobile event overview");
  await expectNoSeriousAxeViolations(page, "mobile event overview");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("overview-390.png") });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(page.locator('aside[aria-label="Organizer navigation"]')).toBeVisible();
  await expect(mobileNavigation).toBeHidden();
  await expectNoHorizontalOverflow(page, "desktop event overview");
  await expectNoSeriousAxeViolations(page, "desktop event overview");
  await page.screenshot({ path: testInfo.outputPath("overview-1440.png"), fullPage: true });

  await page.context().clearCookies();
  await page.goto("/");
  const programHref = await page.getByRole("link", { name: "Open public program", exact: true }).getAttribute("href");
  expect(programHref).not.toBeNull();
  await page.goto(`${programHref!.replace(/\/$/u, "")}/gallery`);
  const galleryCard = page.locator("[data-gallery-speaker-reference]").first();
  await expect(galleryCard).toBeVisible();
  const desktopCardWidth = await galleryCard.evaluate((element) => element.getBoundingClientRect().width);
  expect(desktopCardWidth).toBeLessThanOrEqual(292);
  await expectNoHorizontalOverflow(page, "desktop speaker gallery");
  await expectNoSeriousAxeViolations(page, "desktop speaker gallery");
  await page.screenshot({ path: testInfo.outputPath("gallery-1440.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const mobileCardWidth = await galleryCard.evaluate((element) => element.getBoundingClientRect().width);
  expect(mobileCardWidth).toBeLessThanOrEqual(292);
  await galleryCard.locator("img").evaluate((image) => {
    image.setAttribute("src", "/__final-ux-release-missing-photo__");
  });
  const monogramFallback = galleryCard.getByLabel("Mina Park initials");
  await expect(monogramFallback).toBeVisible();
  await expect(monogramFallback).toHaveText("MP");
  await expectNoHorizontalOverflow(page, "mobile speaker gallery");
  await expectNoSeriousAxeViolations(page, "mobile speaker gallery");
  await page.screenshot({ path: testInfo.outputPath("gallery-390.png"), fullPage: true });
});
