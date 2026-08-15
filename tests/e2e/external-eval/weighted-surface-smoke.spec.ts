import {
  expect,
  test,
  type Locator,
  type Page,
} from "@playwright/test";

type BrowserHealth = {
  readonly serverErrors: string[];
  readonly pageErrors: string[];
};

type OrganizerSurface = {
  readonly linkName: string;
  readonly suffix: string;
  readonly heading: string;
};

const ORGANIZER_SURFACES: readonly OrganizerSurface[] = [
  { linkName: "Organizer CFP", suffix: "cfp", heading: "Call for proposals" },
  { linkName: "Review surface", suffix: "review", heading: "Review evidence" },
  {
    linkName: "Speaker surface",
    suffix: "speakers",
    heading: "Speaker commitments and operations",
  },
  { linkName: "Program builder", suffix: "program", heading: "Plan Studio" },
  {
    linkName: "Publication surface",
    suffix: "publication",
    heading: "Durable publication release",
  },
];

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

async function assertBrowserHealth(health: BrowserHealth): Promise<void> {
  expect(health.serverErrors, "unexpected 5xx responses").toEqual([]);
  expect(health.pageErrors, "unexpected page errors").toEqual([]);
}

async function pathFromLink(link: Locator): Promise<string> {
  const href = await link.getAttribute("href");
  if (!href) throw new Error("Expected a visible link to expose an href");
  return new URL(href, "http://sympose.test").pathname;
}

async function openRoot(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Evaluator persona entry points", level: 2 }),
  ).toBeVisible();
}

async function clickRootLink(page: Page, name: string): Promise<string> {
  const link = page.getByRole("link", { name, exact: true });
  await expect(link).toBeVisible();
  const destinationPath = await pathFromLink(link);
  await Promise.all([
    page.waitForURL((url) => url.pathname === destinationPath),
    link.click(),
  ]);
  return destinationPath;
}

async function signInThroughVisibleOrganizerEntry(page: Page): Promise<{
  readonly dashboardUrl: string;
  readonly eventRootPath: string;
}> {
  await openRoot(page);

  const organizerChoice = page
    .locator("label.login-option")
    .filter({ hasText: "Acme Organizer" })
    .getByRole("radio");
  await expect(organizerChoice).toBeVisible();
  await organizerChoice.check();
  await page.getByRole("button", { name: "Sign in to workspace", exact: true }).click();
  await page.waitForURL((url) => /^\/w\/[^/]+\/dashboard$/u.test(url.pathname));

  const organizerCfpLink = page.getByRole("link", {
    name: "Organizer CFP",
    exact: true,
  });
  await expect(organizerCfpLink).toBeVisible();
  const organizerCfpPath = await pathFromLink(organizerCfpLink);
  const eventMatch = organizerCfpPath.match(/^\/w\/([^/]+)\/events\/([^/]+)\/cfp$/u);
  if (!eventMatch) {
    throw new Error(`Visible organizer CFP link is not event-scoped: ${organizerCfpPath}`);
  }

  return {
    dashboardUrl: page.url(),
    // The event identifier is intentionally taken from the rendered evaluator link.
    eventRootPath: organizerCfpPath.slice(0, -"/cfp".length),
  };
}

async function visitOrganizerSurface(
  page: Page,
  dashboardUrl: string,
  eventRootPath: string,
  surface: OrganizerSurface,
): Promise<void> {
  await page.goto(dashboardUrl);
  const link = page.getByRole("link", { name: surface.linkName, exact: true });
  await expect(link).toBeVisible();
  const surfacePath = await pathFromLink(link);
  expect(surfacePath).toBe(`${eventRootPath}/${surface.suffix}`);

  await Promise.all([
    page.waitForURL((url) => url.pathname === surfacePath),
    link.click(),
  ]);
  await expect(
    page.getByRole("heading", { name: surface.heading, level: 1 }),
  ).toBeVisible();
}

async function visitAnonymousPublicSurfaces(page: Page): Promise<void> {
  await openRoot(page);

  await clickRootLink(page, "Open Stagecraft 2026 CFP");
  await expect(page.getByTestId("applicant-call")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Stagecraft 2026 Call for Proposals", level: 1 }),
  ).toBeVisible();

  await openRoot(page);
  await clickRootLink(page, "Open scoped speaker portal");
  await expect(
    page.getByRole("heading", { name: "Your speaker work starts here", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Preview Priya’s speaker portal" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, Priya Raman", level: 1 })).toBeVisible();

  await openRoot(page);
  const widgetRootPath = await clickRootLink(page, "Open public program");
  await expect(page.getByText("Sealed public release", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Acme Evaluator Summit", level: 1 }),
  ).toBeVisible();

  const widgetSurface = async (name: string): Promise<string> => {
    const navigation = page.getByRole("navigation", { name: "Portable presentation surfaces" });
    const link = navigation.getByRole("link", { name, exact: true });
    await expect(link).toBeVisible();
    const destinationPath = await pathFromLink(link);
    await Promise.all([
      page.waitForURL((url) => url.pathname === destinationPath),
      link.click(),
    ]);
    return destinationPath;
  };

  await widgetSurface("Sessions");
  await expect(page.getByTestId("session-directory")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Find your next conversation", level: 1 }),
  ).toBeVisible();
  const firstSessionLink = page.getByTestId("session-directory").getByRole("link").first();
  await expect(firstSessionLink).toBeVisible();
  const sessionDetailPath = await pathFromLink(firstSessionLink);
  await Promise.all([
    page.waitForURL((url) => url.pathname === sessionDetailPath),
    firstSessionLink.click(),
  ]);
  await expect(page.getByTestId("session-detail")).toBeVisible();

  await page.goto(widgetRootPath);
  await widgetSurface("Speakers");
  await expect(page.getByTestId("speaker-directory")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Meet the people shaping the program", level: 1 }),
  ).toBeVisible();
  const firstSpeakerLink = page.getByTestId("speaker-directory").getByRole("link").first();
  await expect(firstSpeakerLink).toBeVisible();
  const speakerDetailPath = await pathFromLink(firstSpeakerLink);
  await Promise.all([
    page.waitForURL((url) => url.pathname === speakerDetailPath),
    firstSpeakerLink.click(),
  ]);
  await expect(page.getByTestId("speaker-detail")).toBeVisible();

  await page.goto(widgetRootPath);
  await widgetSurface("Agenda view");
  await expect(page.getByTestId("agenda-day")).toBeVisible();
  const agendaDays = page.getByLabel("Agenda day navigation");
  await expect(agendaDays).toBeVisible();
  const firstAgendaDayLink = agendaDays.getByRole("link").first();
  await expect(firstAgendaDayLink).toBeVisible();
  const agendaDayPath = await pathFromLink(firstAgendaDayLink);
  await Promise.all([
    page.waitForURL((url) => url.pathname === agendaDayPath),
    firstAgendaDayLink.click(),
  ]);
  await expect(page.getByTestId("agenda-day")).toBeVisible();

  await page.goto(widgetRootPath);
  await widgetSurface("My itinerary");
  await expect(page.getByTestId("itinerary-panel")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your saved itinerary", level: 2 })).toBeVisible();

  await page.goto(widgetRootPath);
  const presentationTools = page.getByRole("navigation", { name: "Portable presentation tools" });
  const configureLink = presentationTools.getByRole("link", {
    name: "Configure portable embed",
    exact: true,
  });
  const configurePath = await pathFromLink(configureLink);
  await Promise.all([
    page.waitForURL((url) => url.pathname === configurePath),
    configureLink.click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Share the published program", level: 1 }),
  ).toBeVisible();
  const snippet = page.getByLabel("Embed snippet");
  await expect(snippet).toBeVisible();
  await expect(snippet).toHaveJSProperty("readOnly", true);

  await openRoot(page);
  const attendeeLink = page.getByRole("link", { name: "Open current attendee agenda", exact: true });
  const attendeePath = await pathFromLink(attendeeLink);
  expect(attendeePath).toMatch(/^\/events\/aud1-[0-9a-f-]+\/agenda$/u);
  await Promise.all([
    page.waitForURL((url) => url.pathname === attendeePath),
    attendeeLink.click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Acme Evaluator Summit", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Agenda days" }),
  ).toBeVisible();
}

test.describe("weighted-area browser surface smoke", () => {
  test.setTimeout(120_000);

  test("traverses organizer surfaces read-only", async ({ browser }) => {
    const organizerContext = await browser.newContext();
    const organizerPage = await organizerContext.newPage();
    const organizerHealth = monitorBrowserHealth(organizerPage);

    try {
      const { dashboardUrl, eventRootPath } = await signInThroughVisibleOrganizerEntry(organizerPage);
      for (const surface of ORGANIZER_SURFACES) {
        await visitOrganizerSurface(organizerPage, dashboardUrl, eventRootPath, surface);
      }
      await assertBrowserHealth(organizerHealth);
    } finally {
      await organizerContext.close();
    }
  });

  test("traverses anonymous public surfaces read-only", async ({ browser }) => {
    const anonymousContext = await browser.newContext();
    const anonymousPage = await anonymousContext.newPage();
    const anonymousHealth = monitorBrowserHealth(anonymousPage);

    try {
      await openRoot(anonymousPage);
      expect(
        (await anonymousContext.cookies()).some((cookie) => cookie.name === "sympose_session"),
      ).toBe(false);
      await visitAnonymousPublicSurfaces(anonymousPage);
      await assertBrowserHealth(anonymousHealth);
    } finally {
      await anonymousContext.close();
    }
  });

  test("keeps the public root and program reachable at a 390px viewport", async ({ browser }) => {
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const mobilePage = await mobileContext.newPage();
    const mobileHealth = monitorBrowserHealth(mobilePage);

    try {
      await openRoot(mobilePage);
      const widgetRootPath = await clickRootLink(mobilePage, "Open public program");
      expect(new URL(mobilePage.url()).pathname).toBe(widgetRootPath);
      await expect(mobilePage.getByText("Sealed public release", { exact: true })).toBeVisible();
      await expect(
        mobilePage.getByRole("heading", { name: "Acme Evaluator Summit", level: 1 }),
      ).toBeVisible();
      await expect(
        mobilePage.getByRole("navigation", { name: "Portable presentation surfaces" }),
      ).toBeVisible();
      expect(mobilePage.viewportSize()?.width).toBe(390);
      await assertBrowserHealth(mobileHealth);
    } finally {
      await mobileContext.close();
    }
  });
});
