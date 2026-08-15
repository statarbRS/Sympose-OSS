import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

const VIEWPORTS = [
  { width: 1440, height: 1000, label: "1440" },
  { width: 1024, height: 900, label: "1024" },
  { width: 768, height: 900, label: "768" },
  { width: 390, height: 844, label: "390" },
] as const;

async function expectNoPageOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => {
        const rectangle = element.getBoundingClientRect();
        return {
          className: typeof element.className === "string" ? element.className.slice(0, 120) : "",
          right: Math.round(rectangle.right),
          tag: element.tagName.toLowerCase(),
          width: Math.round(rectangle.width),
        };
      })
      .filter((entry) => entry.right > document.documentElement.clientWidth + 1)
      .sort((first, second) => first.right - second.right)
      .slice(0, 8),
  }));
  expect(
    dimensions.scrollWidth,
    `${label} has page-level horizontal overflow: ${JSON.stringify(dimensions.offenders)}`,
  )
    .toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectTouchTarget(locator: Locator, label: string): Promise<void> {
  const size = await locator.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return { height: rectangle.height, width: rectangle.width };
  });
  expect(size.height, `${label} is shorter than 44px`).toBeGreaterThanOrEqual(44);
  expect(size.width, `${label} is narrower than 44px`).toBeGreaterThanOrEqual(44);
}

async function expectHumanEventChrome(page: Page, path: string, label: string): Promise<void> {
  const eventMatch = new URL(path, "http://sympose.test").pathname.match(/\/events\/([^/]+)/u);
  if (!eventMatch?.[1]) return;
  const eventId = decodeURIComponent(eventMatch[1]);
  const shellHeaderText = (await page.locator(".productShell__header").textContent()) ?? "";
  expect(shellHeaderText, `${label} exposes the raw event identifier in default chrome`).not.toContain(eventId);
  expect(shellHeaderText, `${label} substitutes a generic event identity`).not.toContain("Event context");
  const eventName = page.locator("[data-event-name]").first();
  await expect(eventName, `${label} does not render the durable event name`).toBeVisible();
  const eventNameText = (await eventName.textContent())?.trim() ?? "";
  expect(eventNameText, `${label} renders an empty event identity`).not.toBe("");
  expect(eventNameText, `${label} renders the raw event identifier as its name`).not.toContain(eventId);
}

async function capture(page: Page, filename: string): Promise<void> {
  const evidenceDirectory = process.env.SYMPOSE_EVIDENCE_DIR;
  if (!evidenceDirectory) return;
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDirectory, filename), fullPage: false });
}

async function signInAsOrganizer(page: Page): Promise<{
  readonly dashboardPath: string;
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
  const dashboardPath = new URL(page.url()).pathname;
  const programHref = await page.getByRole("link", { name: "Program builder", exact: true })
    .getAttribute("href");
  const personHref = await page.locator(".dash__person-link").first().getAttribute("href");
  if (!programHref || !personHref) throw new Error("The organizer home lost its event or Person continuity links");
  return {
    dashboardPath,
    eventRoot: programHref.replace(/\/program$/u, ""),
    personPath: personHref,
  };
}

async function inspectAtEveryViewport(
  page: Page,
  input: {
    readonly label: string;
    readonly path: string;
    readonly marker: (page: Page) => Locator;
    readonly expectOrganizerEventChrome?: boolean;
    readonly screenshotAt?: string;
  },
): Promise<void> {
  await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
  await page.goto(input.path);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame())));
    await expect(input.marker(page)).toBeVisible({ timeout: 20_000 });
    if (input.expectOrganizerEventChrome) {
      await expectHumanEventChrome(page, input.path, `${input.label} at ${viewport.label}`);
    }
    await expectNoPageOverflow(page, `${input.label} at ${viewport.label}`);
    if (input.screenshotAt === viewport.label) {
      await capture(page, `${input.label}-${viewport.label}.png`);
    }
  }
}

test("the ten approved rooms reflow at 1440, 1024, 768, and 390", async ({ browser }) => {
  test.setTimeout(600_000);

  const organizerContext = await browser.newContext();
  const organizerPage = await organizerContext.newPage();
  const serverErrors: string[] = [];
  organizerPage.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.request().method()}`);
  });
  const { dashboardPath, eventRoot, personPath } = await signInAsOrganizer(organizerPage);

  const organizerRooms = [
    {
      label: "01-home",
      path: dashboardPath,
      marker: (page: Page) => page.getByRole("heading", { name: "Acme Evaluator Summit", level: 1 }),
      screenshotAt: "1440",
    },
    {
      label: "02-person",
      path: personPath,
      marker: (page: Page) => page.getByTestId("person-provenance"),
      screenshotAt: "1024",
    },
    {
      label: "03-plan-studio",
      path: `${eventRoot}/program`,
      marker: (page: Page) => page.getByRole("heading", { name: "Plan Studio", level: 1 }),
      expectOrganizerEventChrome: true,
      screenshotAt: "768",
    },
    {
      label: "04-organizer-review",
      path: `${eventRoot}/review`,
      marker: (page: Page) => page.getByRole("heading", { name: "Review evidence", level: 1 }),
      expectOrganizerEventChrome: true,
      screenshotAt: "390",
    },
    {
      label: "05-speaker-operations",
      path: `${eventRoot}/speakers`,
      marker: (page: Page) => page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 }),
      expectOrganizerEventChrome: true,
      screenshotAt: "1024",
    },
    {
      label: "08-operator",
      path: `${eventRoot}/operations`,
      marker: (page: Page) => page.getByTestId("operator-proof-experience"),
      expectOrganizerEventChrome: true,
      screenshotAt: "390",
    },
    {
      label: "09-publication",
      path: `${eventRoot}/publication`,
      marker: (page: Page) => page.getByRole("heading", { name: "Durable publication release", level: 1 }),
      expectOrganizerEventChrome: true,
      screenshotAt: "1440",
    },
  ] as const;

  for (const room of organizerRooms) await inspectAtEveryViewport(organizerPage, room);

  await organizerPage.setViewportSize({ width: 390, height: 844 });
  await organizerPage.goto(`${eventRoot}/operations`);
  const operatorInstrument = organizerPage.locator('[data-role-instrument="operator"]');
  await expect(operatorInstrument).toBeVisible();
  await expectTouchTarget(operatorInstrument.getByRole("link", { name: "Open full evidence" }), "operator mobile action");
  await expectHumanEventChrome(organizerPage, `${eventRoot}/operations`, "Operations at 390px");
  await expect(organizerPage.locator('[data-shell-surface="operations"]')).toBeVisible();
  await expect(organizerPage.getByRole("navigation", { name: "Operations navigation", exact: true })).toBeVisible();
  await expect(organizerPage.getByRole("navigation", { name: "Organizer navigation", exact: true })).toBeHidden();
  await expect(organizerPage.locator(".productShell__header")).toBeHidden();
  await expect(organizerPage.locator(".productShell__command-trigger")).toBeHidden();
  await expect(organizerPage.getByRole("navigation", { name: "Event product surfaces", exact: true })).toBeHidden();
  await expect(organizerPage.getByRole("navigation", { name: "Mobile workspace navigation", exact: true })).toBeHidden();
  for (const label of ["Live", "Proof", "Activity", "Overview"]) {
    await expectTouchTarget(
      organizerPage.getByRole("navigation", { name: "Operations navigation", exact: true }).getByRole("link", { name: label, exact: true }),
      `operator ${label}`,
    );
  }
  await expectNoPageOverflow(organizerPage, "Operations at 390px after operator shell assertions");

  for (const width of [1440, 1024, 768]) {
    await organizerPage.setViewportSize({ width, height: 900 });
    await organizerPage.goto(`${eventRoot}/operations`);
    await expect(organizerPage.locator(".productShell__rail"), `organizer shell rail is missing at ${width}px`).toBeVisible();
    await expect(organizerPage.locator(".productShell__header"), `organizer shell header is missing at ${width}px`).toBeVisible();
    await expect(organizerPage.locator(".productShell__command-trigger"), `organizer search is missing at ${width}px`).toBeVisible();
    await expect(organizerPage.getByRole("navigation", { name: "Event product surfaces", exact: true }), `event tabs are missing at ${width}px`).toBeVisible();
    await expect(organizerPage.getByTestId("operator-proof-experience"), `operational evidence is missing at ${width}px`).toBeVisible();
    await expect(organizerPage.getByRole("navigation", { name: "Operations navigation", exact: true }), `operator mobile chrome leaked at ${width}px`).toBeHidden();
    await expectHumanEventChrome(organizerPage, `${eventRoot}/operations`, `Operations at ${width}px`);
  }

  for (const width of [767, 768, 769]) {
    await organizerPage.setViewportSize({ width, height: 900 });
    await organizerPage.goto(`${eventRoot}/program`);
    const railAccount = organizerPage.locator(".productShell__rail-account");
    const accountBox = await railAccount.boundingBox();
    const signOutBox = await railAccount.getByRole("button", { name: "Sign out" }).boundingBox();
    expect(accountBox, `organizer account control is missing at ${width}px`).not.toBeNull();
    expect(signOutBox, `organizer sign out is missing at ${width}px`).not.toBeNull();
    expect(accountBox!.width, `organizer account row expands at ${width}px`).toBeLessThan(140);
    expect(signOutBox!.height, `organizer sign out is too short at ${width}px`).toBeGreaterThanOrEqual(44);
    expect(signOutBox!.width, `organizer sign out is too wide at ${width}px`).toBeLessThan(120);
  }

  await organizerPage.setViewportSize({ width: 1440, height: 1000 });
  await organizerPage.goto(dashboardPath);
  await organizerPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await organizerPage.keyboard.press("Tab");
  const focused = organizerPage.locator(":focus");
  await expect(focused).toHaveText("Skip to content");
  const focusRing = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(focusRing.style).not.toBe("none");
  expect(focusRing.width).toBeGreaterThanOrEqual(2);
  await organizerPage.keyboard.press("Enter");
  await expect(organizerPage).toHaveURL(/#main-content$/u);

  await organizerPage.goto(`${eventRoot}/program`);
  const scheduleGrid = organizerPage.getByRole("region", { name: /schedule grid\. Scroll horizontally/u });
  await scheduleGrid.focus();
  await expect(scheduleGrid).toBeFocused();
  await organizerPage.emulateMedia({ reducedMotion: "reduce" });
  const motion = await organizerPage.getByTestId("approve-schedule-draft").evaluate((element) => {
    const style = getComputedStyle(element);
    return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration };
  });
  expect(motion.animationDuration).toMatch(/^(?:0s|0\.0*1ms|1e-05s)$/u);
  expect(motion.transitionDuration).toMatch(/^(?:0s|0\.0*1ms|1e-05s)$/u);
  await organizerPage.setViewportSize({ width: 390, height: 844 });
  const nonDragParity = organizerPage.getByRole("link", { name: "Move without dragging", exact: true });
  await expect(nonDragParity).toBeVisible();
  await expectTouchTarget(nonDragParity, "non-drag placement action");
  expect(serverErrors).toEqual([]);
  await organizerContext.close();

  const reviewerContext = await browser.newContext();
  const reviewerPage = await reviewerContext.newPage();
  await reviewerPage.goto("/");
  await reviewerPage.getByRole("button", { name: "Enter reviewer queue", exact: true }).click();
  await reviewerPage.waitForURL(/\/review\/[^/]+\/queue$/u);
  await reviewerPage.getByRole("link", { name: "Open assignment", exact: true }).click();
  await reviewerPage.waitForURL(/\/review\/[^/]+\/assignments\/[^/]+$/u);
  const reviewerPath = new URL(reviewerPage.url()).pathname;
  await inspectAtEveryViewport(reviewerPage, {
    label: "06-reviewer-room",
    path: reviewerPath,
    marker: (page) => page.getByRole("heading", { name: "Independent proposal review", level: 1 }),
    screenshotAt: "768",
  });
  await reviewerPage.setViewportSize({ width: 768, height: 900 });
  const reviewerSignOutContrast = await reviewerPage.getByRole("button", { name: "Sign out" }).evaluate((element) => {
    const parseRgb = (value: string): readonly number[] => value.match(/[\d.]+/gu)?.slice(0, 3).map(Number) ?? [];
    const luminance = (channels: readonly number[]): number => channels.reduce((sum, channel, index) => {
      const normalized = channel / 255;
      const linear = normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
    }, 0);
    const foreground = luminance(parseRgb(getComputedStyle(element).color));
    const header = element.closest("header");
    if (!header) return 0;
    const background = luminance(parseRgb(getComputedStyle(header).backgroundColor));
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(reviewerSignOutContrast).toBeGreaterThanOrEqual(4.5);
  await reviewerContext.close();

  const speakerContext = await browser.newContext();
  const speakerPage = await speakerContext.newPage();
  await speakerPage.goto("/speaker/entry");
  await speakerPage.getByRole("button", { name: "Preview Mina’s speaker portal", exact: true }).click();
  await speakerPage.waitForURL(/\/speaker$/u);
  await inspectAtEveryViewport(speakerPage, {
    label: "07-speaker-portal",
    path: "/speaker",
    marker: (page) => page.getByRole("heading", { name: "Welcome, Mina Park", level: 1 }),
    screenshotAt: "390",
  });
  await speakerPage.setViewportSize({ width: 390, height: 844 });
  for (const label of ["Tasks", "Readiness", "More details"]) {
    await expectTouchTarget(
      speakerPage.getByRole("navigation", { name: "Speaker portal sections" }).getByRole("link", { name: label, exact: true }),
      `speaker ${label}`,
    );
  }
  await speakerContext.close();

  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  await publicPage.goto("/");
  const agendaHref = await publicPage.getByRole("link", { name: "Open current attendee agenda", exact: true })
    .getAttribute("href");
  if (!agendaHref) throw new Error("The validated public agenda entry is unavailable");
  await inspectAtEveryViewport(publicPage, {
    label: "10-public-event",
    path: agendaHref,
    marker: (page) => page.getByRole("heading", { name: "Acme Evaluator Summit", level: 1 }),
    screenshotAt: "1024",
  });
  await publicContext.close();
});
