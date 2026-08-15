import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function signInAndResolveEvent(page: Page): Promise<{
  readonly workspace: string;
  readonly eventId: string;
}> {
  await page.context().clearCookies();
  await page.goto("/");
  await page
    .locator("label.login-option")
    .filter({ hasText: "Acme Organizer" })
    .getByRole("radio")
    .check();
  await Promise.all([
    page.waitForURL(/\/w\/[^/]+\/dashboard$/u, { timeout: 20_000 }),
    page.getByRole("button", { name: "Sign in to workspace", exact: true }).click(),
  ]);
  await Promise.all([
    page.waitForURL(/\/w\/[^/]+\/events\/[^/]+\/overview$/u, { timeout: 20_000 }),
    page.getByRole("link", { name: "Open event overview", exact: true }).first().click(),
  ]);
  const match = new URL(page.url()).pathname.match(/^\/w\/([^/]+)\/events\/([^/]+)\/overview$/u);
  if (!match) throw new Error("Unable to resolve the authorized event route.");
  return { workspace: match[1]!, eventId: match[2]! };
}

async function expectNoSeriousAxeFindings(
  page: Page,
  surface: string,
  include: string,
): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include(include)
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = result.violations.filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? ""),
  );
  expect(violations, `${surface} has critical or serious Axe findings`).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, surface: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth, `${surface} overflows horizontally`).toBeLessThanOrEqual(
    dimensions.clientWidth,
  );
}

async function expectUnoccluded(locator: Locator, label: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
  const unobscured = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(0, box.left + box.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, box.top + box.height / 2));
    const top = document.elementFromPoint(x, y);
    return top !== null && (top === element || element.contains(top) || top.contains(element));
  });
  expect(unobscured, `${label} is occluded at its center point`).toBe(true);
}

test("operations surfaces stay action-first, truthful, accessible, and reflowable", async ({ page }) => {
  test.setTimeout(180_000);

  await page.setViewportSize({ width: 1440, height: 900 });
  const { workspace, eventId } = await signInAndResolveEvent(page);
  const eventBase = `/w/${workspace}/events/${eventId}`;

  for (const viewport of [
    { width: 1440, height: 900, label: "desktop" },
    { width: 390, height: 844, label: "390px mobile" },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto(`${eventBase}/publication`);
    await expect(page.getByRole("heading", { name: "Current durable event projection", level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("publication-audience-counts")).toContainText("Included agendas");
    await expect(page.getByTestId("publication-audience-counts")).toContainText("Excluded accepted people");
    await expect(page.getByTestId("publication-audience-counts")).toContainText("Redacted field groups");
    await expect(page.getByText("Pre-seal diff is not exposed by this service.", { exact: true })).toBeVisible();
    await expectUnoccluded(page.getByRole("heading", { name: "What the public audience can see now" }), `publication preview at ${viewport.label}`);
    await expect(page.getByTestId("publication-seal-receipt")).toHaveCount(0);
    await page.getByText("Validate current authoritative inputs", { exact: true }).click();
    await expectUnoccluded(page.getByRole("button", { name: "Check and seal exact current inputs", exact: true }), `publication handoff at ${viewport.label}`);
    await expectNoHorizontalOverflow(page, `publication at ${viewport.label}`);
    await expectNoSeriousAxeFindings(page, `publication at ${viewport.label}`, '[data-testid="publication-console"]');

    await page.goto(`${eventBase}/readiness`);
    await expect(page.getByRole("heading", { name: "Readiness command center", level: 1 })).toBeVisible({ timeout: 20_000 });
    const severity = await page.locator("[data-readiness-severity]").evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-readiness-severity")),
    );
    const rank: Readonly<Record<string, number>> = { blocked: 0, unavailable: 1, attention: 2, ready: 3 };
    expect(severity.map((tone) => rank[tone ?? ""] ?? 99)).toEqual(
      [...severity.map((tone) => rank[tone ?? ""] ?? 99)].sort((first, second) => first - second),
    );
    await expectUnoccluded(page.getByRole("heading", { name: "Blocked, then unavailable, then attention" }), `readiness queue at ${viewport.label}`);
    await expectNoHorizontalOverflow(page, `readiness at ${viewport.label}`);
    await expectNoSeriousAxeFindings(page, `readiness at ${viewport.label}`, '[data-testid="event-readiness-command-center"]');

    await page.goto(`/w/${workspace}/connectors`);
    await expect(page.getByRole("heading", { name: "Connector Hub", level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("connector-primary-export")).toContainText("Immediately usable");
    await expect(page.getByTestId("connector-primary-export")).toContainText("Airtable API not configured");
    await expect(page.locator('[data-provider="hubspot"]')).toContainText("Not configured");
    await expect(page.locator('[data-provider="salesforce"]')).toContainText("Not configured");
    await expectUnoccluded(page.getByRole("heading", { name: "Airtable-compatible People export" }), `connector export at ${viewport.label}`);
    await expectUnoccluded(page.getByRole("button", { name: /Download .* Airtable row/u }), `connector download at ${viewport.label}`);
    await expectNoHorizontalOverflow(page, `connector hub at ${viewport.label}`);
    await expectNoSeriousAxeFindings(page, `connector hub at ${viewport.label}`, '[data-testid="connector-hub"]');

    await page.goto(`${eventBase}/delivery`);
    await expect(page.getByRole("heading", { name: "Delivery Center", level: 1 })).toBeVisible({ timeout: 20_000 });
    const records = page.locator("#delivery-center-records");
    const boundary = page.getByTestId("delivery-center-provider-boundary");
    expect(await records.evaluate((element) => element.compareDocumentPosition(document.querySelector('[data-testid="delivery-center-provider-boundary"]')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    const priorities = await page.locator("[data-delivery-priority]").evaluateAll((elements) =>
      elements.map((element) => Number(element.getAttribute("data-delivery-priority"))),
    );
    expect(priorities).toEqual([...priorities].sort((first, second) => first - second));
    if (priorities.length > 0) {
      await expect(page.locator("[data-delivery-priority]").first()).toContainText("Rendered subject");
      await expectUnoccluded(page.locator("[data-delivery-priority]").first().getByText("Rendered subject"), `delivery evidence at ${viewport.label}`);
    } else {
      await expect(page.getByTestId("delivery-center-empty")).toBeVisible();
    }
    await expect(boundary).toContainText("No provider or SMTP contact");
    await expectNoHorizontalOverflow(page, `delivery center at ${viewport.label}`);
    await expectNoSeriousAxeFindings(page, `delivery center at ${viewport.label}`, '[data-testid="delivery-center"]');
  }
});
