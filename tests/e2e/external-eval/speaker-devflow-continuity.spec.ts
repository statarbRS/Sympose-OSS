import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

type BrowserHealth = {
  readonly serverErrors: string[];
  readonly pageErrors: string[];
};

function monitorBrowserHealth(page: Page): BrowserHealth {
  const health: BrowserHealth = { serverErrors: [], pageErrors: [] };
  page.on("response", (response) => {
    if (response.status() >= 500) health.serverErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  page.on("pageerror", (error) => health.pageErrors.push(error.message));
  return health;
}

async function signInDevflowOrganizer(page: Page): Promise<void> {
  await page.goto("/");
  const choice = page.locator("label.login-option").filter({ hasText: "Jordan Alvarez" }).getByRole("radio");
  await expect(choice).toBeVisible();
  await choice.check();
  await page.getByRole("button", { name: "Sign in to workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/devflow\/dashboard$/u, { timeout: 20_000 });
}

async function openDevflowSpeakerSurface(page: Page): Promise<string> {
  const link = page.getByRole("link", { name: "Check speakers", exact: true });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  if (!href) throw new Error("DevFlow speaker surface link has no href");
  const path = new URL(href, "http://sympose.test").pathname;
  await link.click();
  await expect(page).toHaveURL(path, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 })).toBeVisible();
  return path;
}

function priyaRow(page: Page): Locator {
  return page.getByRole("table", { name: "Canonical people with event-scoped speaker and moderator projections" })
    .locator("tbody tr")
    .filter({ hasText: "Priya Raman" })
    .first();
}

async function openPriyaControls(page: Page): Promise<{ readonly row: Locator; readonly status: Locator }> {
  const row = priyaRow(page);
  const summary = row.getByText("Profile, session, and task controls", { exact: true });
  const disclosure = summary.locator("xpath=ancestor::details[1]");
  if (await disclosure.getAttribute("open") === null) await summary.click();
  const status = row.getByLabel("Workflow status for Priya Raman");
  await expect(status).toBeVisible();
  return { row, status };
}

async function submitCurrentPageAction(page: Page, button: Locator): Promise<number> {
  const actionPath = new URL(page.url()).pathname;
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => candidate.request().method() === "POST" && new URL(candidate.url()).pathname === actionPath,
    ),
    button.click(),
  ]);
  return response.status();
}

async function expectForgedPreviewDenied(
  page: Page,
  speakerPath: string,
  field: "workspace" | "personId",
  forgedValue: string,
): Promise<void> {
  const row = priyaRow(page);
  const preview = row.getByRole("button", { name: "Open local preview", exact: true });
  const previewForm = preview.locator("xpath=ancestor::form[1]");
  await previewForm.locator(`input[name="${field}"]`).evaluate((input, value) => {
    (input as HTMLInputElement).value = value;
  }, forgedValue);
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === speakerPath
  );
  await preview.click();
  const response = await responsePromise;
  expect(response.status(), `forged ${field} submission must fail closed`).toBeGreaterThanOrEqual(400);
  await expect(page).toHaveURL((url) => url.pathname === speakerPath);
  const scopedCookies = (await page.context().cookies())
    .filter((cookie) => cookie.name === "sympose_speaker_portal" || cookie.name === "sympose_speaker_support_preview")
    .map((cookie) => cookie.name);
  expect(scopedCookies, `forged ${field} submission created portal authority`).toEqual([]);
}

function contrastRatio(foreground: string, background: string): number {
  const rgb = (value: string): [number, number, number] => {
    const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/u);
    if (!match) throw new Error(`Expected an RGB computed color, got ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const luminance = (value: string): number => rgb(value).reduce((sum, channel, index) => {
    const normalized = channel / 255;
    const linear = normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
  }, 0);
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

test.describe("DevFlow speaker continuity repair", () => {
  test.setTimeout(120_000);

  test("organizer opens the accepted Priya portal, reloads it, and persists workflow filtering", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    const health = monitorBrowserHealth(page);
    await signInDevflowOrganizer(page);
    const speakerPath = await openDevflowSpeakerSurface(page);
    const row = priyaRow(page);
    await expect(row).toBeVisible();
    await expect(page.getByRole("table").getByText("Marcus Okafor", { exact: true })).toHaveCount(0);

    await Promise.all([
      page.waitForURL((url) => url.pathname === "/speaker" && url.searchParams.get("from") === "devflow"),
      row.getByRole("button", { name: "Open local preview", exact: true }).click(),
    ]);
    await expect(page).toHaveURL(/\/speaker\?from=devflow$/u);
    await expect(page.getByRole("heading", { name: "Welcome, Priya Raman", level: 1 })).toBeVisible();
    expect(new URL(page.url()).search).not.toContain("token");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Welcome, Priya Raman", level: 1 })).toBeVisible();

    await Promise.all([
      page.waitForURL((url) => url.pathname === "/speaker/entry"),
      page.getByRole("button", { name: "Close portal", exact: true }).click(),
    ]);
    await expect(page).toHaveURL((url) => url.pathname === "/speaker/entry");
    await page.goto(speakerPath);
    const { row: reloadedRow, status } = await openPriyaControls(page);
    await expect(status).toHaveValue("NEW");
    await status.selectOption("READY");
    expect(
      await submitCurrentPageAction(
        page,
        reloadedRow.getByRole("button", { name: "Save status", exact: true }),
      ),
    ).toBeLessThan(400);
    await expect(priyaRow(page).getByLabel("Workflow status for Priya Raman")).toHaveValue("READY");

    const stalePage = await page.context().newPage();
    const staleHealth = monitorBrowserHealth(stalePage);
    stalePage.setDefaultTimeout(20_000);
    await stalePage.goto(speakerPath);
    const { row: staleRow, status: staleStatus } = await openPriyaControls(stalePage);
    await expect(staleStatus).toHaveValue("READY");
    const { row: currentRow, status: currentStatus } = await openPriyaControls(page);
    await currentStatus.selectOption("ON_HOLD");
    expect(
      await submitCurrentPageAction(
        page,
        currentRow.getByRole("button", { name: "Save status", exact: true }),
      ),
    ).toBeLessThan(400);
    await expect(priyaRow(page).getByLabel("Workflow status for Priya Raman")).toHaveValue("ON_HOLD");
    await staleStatus.selectOption("COMPLETED");
    const staleStatusCode = await submitCurrentPageAction(
      stalePage,
      staleRow.getByRole("button", { name: "Save status", exact: true }),
    );
    expect(staleStatusCode).toBe(200);
    await expect(staleHealth.serverErrors, "stale tab returned an unexpected 5xx").toEqual([]);
    await stalePage.reload();
    await expect(priyaRow(stalePage).getByLabel("Workflow status for Priya Raman")).toHaveValue("ON_HOLD");
    await stalePage.close();

    const statusFilter = page.locator('form[method="get"] select[name="status"]');
    await statusFilter.selectOption("ON_HOLD");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect(page).toHaveURL(/status=ON_HOLD/u);
    const { row: filteredRow } = await openPriyaControls(page);
    await expect(filteredRow).toBeVisible();
    await expect(page.getByText("No authorized speakers match the current filters.", { exact: true })).toHaveCount(0);
    await expect(
      filteredRow.getByText("Separate from commitment, tasks, readiness, and delivery evidence.", { exact: true }),
    ).toBeVisible();
    await expect(health.serverErrors, "unexpected 5xx responses").toEqual([]);
    await expect(health.pageErrors, "unexpected page errors").toEqual([]);
  });

  test("fails closed for forged organizer scope and proves entry controls at desktop and mobile sizes", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await signInDevflowOrganizer(page);
    const speakerPath = await openDevflowSpeakerSurface(page);
    const row = priyaRow(page);
    const statusBeforeForgery = await row.getByLabel("Workflow status for Priya Raman").inputValue();

    await expectForgedPreviewDenied(page, speakerPath, "workspace", "acme");
    await page.reload();
    await expect(priyaRow(page).getByLabel("Workflow status for Priya Raman")).toHaveValue(statusBeforeForgery);

    await expectForgedPreviewDenied(page, speakerPath, "personId", "forged-other-person");
    await page.reload();
    await expect(priyaRow(page).getByLabel("Workflow status for Priya Raman")).toHaveValue(statusBeforeForgery);

    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(speakerPath);
      const { status } = await openPriyaControls(page);
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        const statusMetrics = await status.evaluate((element) => {
          element.focus();
          const style = getComputedStyle(element);
          const surface = getComputedStyle(document.body).backgroundColor;
          return {
            focusVisible: element.matches(":focus-visible"),
            outlineColor: style.outlineColor,
            outlineWidth: style.outlineWidth,
            surface,
          };
        });
        expect(statusMetrics.focusVisible).toBe(true);
        expect(statusMetrics.outlineColor).not.toBe("transparent");
        expect(Number.parseFloat(statusMetrics.outlineWidth)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(statusMetrics.outlineColor, statusMetrics.surface)).toBeGreaterThanOrEqual(3);
      }
    }

    await page.context().clearCookies({ name: "sympose_speaker_portal" });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/speaker/entry");
      await expect(page.getByRole("heading", { name: "Your speaker work starts here", level: 1 })).toBeVisible();
      const organizerEntry = page.getByRole("button", { name: "Open my speaker portal", exact: true });
      const evaluatorEntry = page.getByRole("button", { name: "Preview Priya’s speaker portal", exact: true });
      await expect(organizerEntry).toBeVisible();
      await expect(page.getByText("Compatibility reference · DevFlow Conf 2027", { exact: true })).toBeVisible();
      for (const [label, control] of [["organizer entry", organizerEntry], ["evaluator preview", evaluatorEntry]] as const) {
        await control.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
        const hitPoint = await control.evaluate((element) => {
          const rectangle = element.getBoundingClientRect();
          const y = Math.min(window.innerHeight - 1, Math.max(0, rectangle.top + rectangle.height / 2));
          const hitAt = (fraction: number): boolean => {
            const x = Math.min(window.innerWidth - 1, Math.max(0, rectangle.left + rectangle.width * fraction));
            const hit = document.elementFromPoint(x, y);
            return hit === element || (hit !== null && element.contains(hit));
          };
          return {
            height: rectangle.height,
            hit: [0.25, 0.5, 0.75].every(hitAt),
            withinViewport: rectangle.left >= 0 && rectangle.right <= window.innerWidth && rectangle.top >= 0 && rectangle.bottom <= window.innerHeight,
          };
        });
        expect(hitPoint.height, `${label} is below the 44px target at ${viewport.width}px`).toBeGreaterThanOrEqual(44);
        expect(hitPoint.withinViewport, `${label} is outside the viewport at ${viewport.width}px`).toBe(true);
        expect(hitPoint.hit, `${label} is visually occluded at ${viewport.width}px`).toBe(true);
      }
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        const button = evaluatorEntry;
        await expect(button).toBeVisible();
        const metrics = await button.evaluate((element) => {
          element.focus();
          const style = getComputedStyle(element);
          const surface = getComputedStyle(document.querySelector("main") ?? document.body).backgroundColor;
          return {
            height: element.getBoundingClientRect().height,
            color: style.color,
            background: style.backgroundColor,
            outlineColor: style.outlineColor,
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            focusVisible: element.matches(":focus-visible"),
            surface,
          };
        });
        expect(metrics.height).toBeGreaterThanOrEqual(44);
        expect(contrastRatio(metrics.color, metrics.background)).toBeGreaterThanOrEqual(4.5);
        expect(metrics.focusVisible).toBe(true);
        expect(metrics.outlineStyle).not.toBe("none");
        expect(Number.parseFloat(metrics.outlineWidth)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(metrics.outlineColor, metrics.surface)).toBeGreaterThanOrEqual(3);

        const accessibility = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(
          accessibility.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? "")),
          `speaker entry has critical or serious Axe violations at ${viewport.width}px in ${theme} theme`,
        ).toEqual([]);
      }

      const layout = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(layout.scrollWidth, `speaker entry overflows at ${viewport.width}px`).toBeLessThanOrEqual(layout.clientWidth);
    }
  });
});
