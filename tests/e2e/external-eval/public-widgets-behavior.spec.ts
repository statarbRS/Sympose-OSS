import AxeBuilder from "@axe-core/playwright";
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

async function visibleTarget(link: Locator): Promise<URL> {
  const href = await link.getAttribute("href");
  if (!href) throw new Error("Expected a visible link to expose an href");
  return new URL(href, "http://sympose.test");
}

async function followVisibleLink(page: Page, link: Locator): Promise<URL> {
  const target = await visibleTarget(link);
  await Promise.all([
    page.waitForURL((url) => url.pathname === target.pathname && url.search === target.search),
    link.click(),
  ]);
  return target;
}

async function openWidgetSurface(page: Page, name: string): Promise<URL> {
  const link = page
    .getByRole("navigation", { name: "Portable presentation surfaces" })
    .getByRole("link", { name, exact: true });
  await expect(link).toBeVisible();
  return followVisibleLink(page, link);
}

async function expectNoSeriousAxeViolations(page: Page, surface: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = result.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""));
  expect(violations, `${surface} has critical or serious Axe violations`).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, surface: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth, `${surface} overflows horizontally`).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectControlUnoccluded(control: Locator, label: string): Promise<void> {
  await control.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
  const metrics = await control.evaluate((element) => {
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
  expect(metrics.height, `${label} is smaller than the 44px editorial target`).toBeGreaterThanOrEqual(44);
  expect(metrics.withinViewport, `${label} is outside the viewport`).toBe(true);
  expect(metrics.hit, `${label} is visually occluded`).toBe(true);
}

async function chooseDifferentOption(select: Locator): Promise<string> {
  const current = await select.inputValue();
  const options = select.locator("option");
  for (let index = 0; index < await options.count(); index += 1) {
    const value = await options.nth(index).getAttribute("value");
    if (value && value !== current) {
      await select.selectOption(value);
      return value;
    }
  }
  throw new Error(`Expected ${await select.getAttribute("aria-label")} to have an alternate option`);
}

test("crawls every default public widget link through one populated sealed-release reference", async ({ page }) => {
  await page.goto("/");
  const publicProgramHref = await page.getByRole("link", { name: "Open public program", exact: true }).getAttribute("href");
  const attendeeAgendaHref = await page.getByRole("link", { name: "Open current attendee agenda", exact: true }).getAttribute("href");
  if (!publicProgramHref) throw new Error("The default public program link is missing");
  const releaseReference = publicProgramHref.match(/^\/embed\/(aud1-[0-9a-f-]+)$/u)?.[1] ?? "";
  expect(releaseReference).toMatch(/^aud1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(attendeeAgendaHref).toBe(`/events/${releaseReference}/agenda`);

  const rootPublicHrefs = await page.locator('a[href^="/embed/"], a[href^="/events/"]').evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")).filter((href): href is string => href !== null),
  );
  expect(rootPublicHrefs.length).toBeGreaterThanOrEqual(2);
  expect(rootPublicHrefs.every((href) => href.includes(releaseReference))).toBe(true);

  await page.goto("/walkthrough");
  const walkthroughHrefs = await page.getByTestId("walkthrough-public-widget-links").getByRole("link").evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  );
  expect(walkthroughHrefs).toEqual([
    `/embed/${releaseReference}/sessions`,
    `/embed/${releaseReference}/speakers`,
    `/embed/${releaseReference}/gallery`,
    `/embed/${releaseReference}/agenda`,
    `/embed/${releaseReference}/itinerary`,
  ]);
  const publisherTool = page.getByTestId("walkthrough-publisher-tool").getByRole("link", {
    name: "Configure portable embed",
    exact: true,
  });
  await expect(publisherTool).toHaveAttribute("href", `/embed/${releaseReference}/configure`);
  expect(walkthroughHrefs).not.toContain(`/embed/${releaseReference}/configure`);
  await expect(page.getByRole("link", { name: "Open attendee agenda", exact: true }).first())
    .toHaveAttribute("href", `/events/${releaseReference}/agenda`);

  const populatedMarkers = [
    'data-testid="session-directory"',
    'data-testid="speaker-directory"',
    'data-testid="speaker-gallery"',
    'data-testid="agenda-day"',
    'data-testid="itinerary-panel"',
  ];
  for (const [index, href] of walkthroughHrefs.entries()) {
    if (!href) throw new Error("A walkthrough widget link is missing its canonical href");
    const response = await page.request.get(href);
    expect(response.status(), `${href} should resolve`).toBe(200);
    const body = await response.text();
    expect(body).toContain("Acme Evaluator Summit");
    expect(body, `${href} should render its populated content surface`).toContain(populatedMarkers[index]);
    expect(body).not.toMatch(/demo-public|workspace-synthetic-public|browser-public/iu);
  }
  const publisherToolResponse = await page.request.get(`/embed/${releaseReference}/configure`);
  expect(publisherToolResponse.status()).toBe(200);
  expect(await publisherToolResponse.text()).toContain('data-testid="embed-manager"');

  const feedResponse = await page.request.get(`/embed/${releaseReference}/feed`);
  expect(feedResponse.status()).toBe(200);
  const feed = await feedResponse.json() as {
    channelReference?: unknown;
    releaseReference?: unknown;
    sessions?: unknown[];
    speakers?: unknown[];
  };
  expect(feed.channelReference).toBe(releaseReference);
  expect(feed.releaseReference).toBe(releaseReference);
  expect(feed.sessions?.length).toBeGreaterThan(0);
  expect(feed.speakers?.length).toBeGreaterThan(0);
  expect(JSON.stringify(feed)).not.toMatch(/demo-public|workspace-synthetic-public|browser-public/iu);
});

test("exercises public widget behavior and organizer source comparison", async ({ page }) => {
  test.setTimeout(180_000);
  const health = monitorBrowserHealth(page);

  await page.goto("/");
  const publicProgramLink = page.getByRole("link", { name: "Open public program", exact: true });
  await expect(publicProgramLink).toBeVisible();
  const widgetRoot = await followVisibleLink(page, publicProgramLink);
  await expect(page.getByTestId("public-source-release")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Portable presentation surfaces" })).toBeVisible();
  const channelReference = widgetRoot.pathname.split("/").at(-1) ?? "";
  expect(channelReference).toMatch(/^aud1-[0-9a-f-]+$/u);
  await expect(page.getByTestId("canonical-public-event")).toHaveAttribute("href", `/events/${channelReference}/agenda`);
  await expect(page.getByRole("navigation", { name: "Portable presentation tools" }).getByRole("link", { name: "Configure portable embed", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Portable presentation surfaces" }).getByRole("link", { name: "Embed", exact: true })).toHaveCount(0);

  const sessionsPath = await openWidgetSurface(page, "Sessions");
  const sessionCards = page.getByTestId("session-card");
  const allSessionCount = await sessionCards.count();
  expect(allSessionCount).toBe(1);

  const firstSession = sessionCards.first();
  const sessionTitle = (await firstSession.locator("h3").innerText()).trim();
  expect(sessionTitle).not.toBe("");
  const sessionSpeakerLink = page.locator('[data-testid="session-card"] [aria-label="Session speakers"] a').first();
  await expect(sessionSpeakerLink).toBeVisible();
  const sessionSpeakerName = (await sessionSpeakerLink.locator("span").first().innerText()).trim();
  expect(sessionSpeakerName).not.toBe("");

  const sessionSearch = page.getByLabel("Search sessions and speakers");
  await sessionSearch.fill(sessionTitle);
  await Promise.all([
    page.waitForURL((url) => url.pathname === sessionsPath.pathname && url.searchParams.get("q") === sessionTitle),
    page.getByRole("button", { name: "Apply", exact: true }).click(),
  ]);
  await expect(page.getByTestId("session-card")).toHaveCount(1);
  await expect(page.getByTestId("session-card").first().locator("h3")).toHaveText(sessionTitle);

  await openWidgetSurface(page, "Sessions");
  await sessionSearch.fill(sessionSpeakerName);
  await Promise.all([
    page.waitForURL((url) => url.pathname === sessionsPath.pathname && url.searchParams.get("q") === sessionSpeakerName),
    page.getByRole("button", { name: "Apply", exact: true }).click(),
  ]);
  await expect(page.getByTestId("session-card").first().locator('[aria-label="Session speakers"]')).toContainText(sessionSpeakerName);

  await openWidgetSurface(page, "Sessions");
  const trackSelect = page.getByLabel("Track");
  const trackOption = trackSelect.locator("option").nth(1);
  const trackValue = await trackOption.getAttribute("value");
  const trackLabel = (await trackOption.innerText()).trim();
  expect(trackValue).not.toBeNull();
  expect(trackLabel).not.toBe("");
  await trackSelect.selectOption(trackValue!);
  await Promise.all([
    page.waitForURL((url) => url.pathname === sessionsPath.pathname && url.searchParams.get("track") === trackValue),
    page.getByRole("button", { name: "Apply", exact: true }).click(),
  ]);
  const filteredSessionCards = page.getByTestId("session-card");
  const filteredSessionCount = await filteredSessionCards.count();
  expect(filteredSessionCount).toBe(allSessionCount);
  await expect(filteredSessionCards.first()).toContainText(trackLabel);

  await trackSelect.selectOption({ label: "All tracks" });
  await sessionSearch.fill("");
  await Promise.all([
    page.waitForURL((url) => url.pathname === sessionsPath.pathname && !url.searchParams.get("track") && !url.searchParams.get("q")),
    page.getByRole("button", { name: "Apply", exact: true }).click(),
  ]);
  await expect(page.getByTestId("session-card")).toHaveCount(allSessionCount);

  const detailLink = page.getByTestId("session-card").first().getByRole("link", { name: "View full details", exact: true });
  await followVisibleLink(page, detailLink);
  await expect(page.getByTestId("session-detail").getByRole("heading", { name: sessionTitle, level: 1 })).toBeVisible();
  await followVisibleLink(page, page.getByRole("link", { name: /All sessions/u }));
  await expect(page.getByTestId("session-directory")).toBeVisible();

  await openWidgetSurface(page, "Speakers");
  const firstSpeakerCard = page.locator("[data-speaker-reference]").first();
  const speakerName = (await firstSpeakerCard.locator("h2").innerText()).trim();
  const speakerSearch = page.getByLabel("Search speakers");
  await speakerSearch.fill(speakerName);
  await Promise.all([
    page.waitForURL((url) => url.searchParams.get("q") === speakerName),
    page.getByRole("button", { name: "Search", exact: true }).click(),
  ]);
  const filteredSpeakerCards = page.locator("[data-speaker-reference]");
  await expect(filteredSpeakerCards).toHaveCount(1);
  await expect(filteredSpeakerCards.first()).toContainText(speakerName);
  await followVisibleLink(page, filteredSpeakerCards.first().getByRole("link").first());
  await expect(page.getByTestId("speaker-detail").getByRole("heading", { name: speakerName, level: 1 })).toBeVisible();
  await followVisibleLink(page, page.getByRole("link", { name: /Speaker directory/u }));
  await expect(page.getByTestId("speaker-directory")).toBeVisible();

  await openWidgetSurface(page, "Gallery");
  const galleryCards = page.locator("[data-gallery-speaker-reference]");
  expect(await galleryCards.count()).toBeGreaterThan(0);
  const gallerySpeaker = galleryCards.filter({ hasText: speakerName }).first();
  await expect(gallerySpeaker).toBeVisible();
  await followVisibleLink(page, gallerySpeaker.getByRole("link").first());
  await expect(page.getByTestId("speaker-gallery-detail").getByRole("heading", { name: speakerName, level: 1 })).toBeVisible();
  await followVisibleLink(page, page.getByRole("link", { name: /Back to gallery/u }));
  await expect(page.getByTestId("speaker-gallery")).toBeVisible();

  await openWidgetSurface(page, "Agenda view");
  const dayNavigation = page.getByLabel("Agenda day navigation");
  const dayLinks = dayNavigation.getByRole("link");
  await expect(dayLinks).toHaveCount(1);
  const acceptedDay = dayLinks.first();
  const acceptedDayLabel = (await acceptedDay.locator("span").first().innerText()).trim();
  const acceptedDayTarget = await followVisibleLink(page, acceptedDay);
  expect(new URL(page.url()).pathname).toBe(acceptedDayTarget.pathname);
  await expect(page.getByTestId("agenda-day").getByRole("heading", { level: 2 })).toHaveText(acceptedDayLabel);
  await expect(page.getByTestId("agenda-day").getByTestId("session-card").first()).toBeVisible();

  await openWidgetSurface(page, "My itinerary");
  const itineraryPanel = page.getByTestId("itinerary-panel");
  await expect(itineraryPanel).toBeVisible();
  await expect(itineraryPanel.getByRole("link", { name: /Download/u })).toHaveCount(0);
  await expect(page.getByTestId("itinerary-empty")).toContainText("Your itinerary is empty.");
  await page.getByTestId("itinerary-empty").getByRole("button", { name: "Browse published sessions", exact: true }).click();
  const itineraryCards = page.getByTestId("itinerary-session-card");
  await expect(itineraryCards).toHaveCount(allSessionCount);
  const firstItineraryCard = itineraryCards.nth(0);
  const itineraryTitle = (await firstItineraryCard.getByRole("heading", { level: 4 }).innerText()).trim();
  await firstItineraryCard.getByRole("button", { name: "Save session to itinerary", exact: true }).click();
  await expect(itineraryPanel.getByText("1 saved", { exact: true })).toBeVisible();
  const itineraryStorage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(Object.keys(itineraryStorage).filter((key) => key.startsWith("sympose:public-itinerary:"))).toEqual([
    `sympose:public-itinerary:${channelReference}`,
  ]);
  expect(JSON.stringify(itineraryStorage)).not.toMatch(/demo-public|workspace-synthetic-public|browser-public/iu);
  await itineraryPanel.getByRole("button", { name: "Saved sessions (1)", exact: true }).click();
  await expect(itineraryCards).toHaveCount(1);
  await expect(itineraryCards.first()).toContainText(itineraryTitle);

  await page.reload();
  await expect(itineraryPanel).toBeVisible();
  await expect(itineraryPanel.getByText("1 saved", { exact: true })).toBeVisible();
  await expect(page.getByTestId("itinerary-session-card")).toHaveCount(1);
  await expect(page.getByTestId("itinerary-session-card").first()).toContainText(itineraryTitle);
  const calendarLink = page.getByRole("link", { name: "Download 1 saved session", exact: true });
  const calendarTarget = await visibleTarget(calendarLink);
  expect(calendarTarget.pathname).toBe(`${widgetRoot.pathname}/calendar.ics`);
  expect(calendarTarget.searchParams.get("sessions")).not.toBeNull();
  const downloadPromise = page.waitForEvent("download");
  await calendarLink.click();
  const calendarDownload = await downloadPromise;
  expect(calendarDownload.suggestedFilename()).toMatch(/\.ics$/u);

  await followVisibleLink(
    page,
    page.getByRole("navigation", { name: "Portable presentation tools" }).getByRole("link", { name: "Configure portable embed", exact: true }),
  );
  const embedManager = page.getByTestId("embed-manager");
  await expect(embedManager).toBeVisible();
  const embedMode = embedManager.getByLabel("Surface", { exact: true });
  const embedTheme = embedManager.getByLabel("Theme", { exact: true });
  const embedAccent = embedManager.getByLabel("Accent", { exact: true });
  const embedSearch = embedManager.getByLabel("Enable search controls", { exact: true });
  const selectedMode = await chooseDifferentOption(embedMode);
  const selectedTheme = await chooseDifferentOption(embedTheme);
  const selectedAccent = await chooseDifferentOption(embedAccent);
  const selectedSearch = !(await embedSearch.isChecked());
  await embedSearch.setChecked(selectedSearch);
  await page.getByRole("button", { name: "Update preview", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("mode")).toBe(selectedMode);
  await expect.poll(() => new URL(page.url()).searchParams.get("theme")).toBe(selectedTheme);
  await expect.poll(() => new URL(page.url()).searchParams.get("accent")).toBe(selectedAccent);
  await expect.poll(() => new URL(page.url()).searchParams.get("search")).toBe(selectedSearch ? "1" : "0");
  const configuredEmbedUrl = page.url();
  await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toHaveCount(0);
  await expect(page.getByText(/Sign in through the event publication surface to save/u)).toBeVisible();
  const snippet = page.getByLabel("Embed snippet");
  await expect(snippet).toHaveJSProperty("readOnly", true);
  await expect(snippet).toHaveValue(new RegExp(channelReference, "u"));

  await followVisibleLink(page, page.getByRole("link", { name: "Open snippet response", exact: true }));
  await expect(page.locator("body")).toContainText(channelReference);
  await expect(page.locator("body")).toContainText("iframe");
  await page.goto(configuredEmbedUrl);
  await expect(embedManager).toBeVisible();
  await followVisibleLink(page, page.getByRole("link", { name: /Open feed/u }));
  await expect(page.locator("body")).toContainText(channelReference);
  await expect(page.locator("body")).toContainText("sessions");

  await page.goto("/");
  const organizerChoice = page
    .locator("label.login-option")
    .filter({ hasText: "Acme Organizer" })
    .getByRole("radio");
  await organizerChoice.check();
  await Promise.all([
    page.waitForURL((url) => /^\/w\/[^/]+\/dashboard$/u.test(url.pathname)),
    page.getByRole("button", { name: "Sign in to workspace", exact: true }).click(),
  ]);
  await followVisibleLink(page, page.getByRole("link", { name: "Publication surface", exact: true }));
  await expect(page.getByRole("heading", { name: "Truthful durable projection", level: 2 })).toBeVisible();
  const internalReleaseId = (await page.getByTestId("durable-current-release").locator("code").innerText()).trim();
  const organizerRelease = await page.getByTestId("organizer-source-release").innerText();
  const internalFingerprint = organizerRelease.match(/[a-f0-9]{64}/u)?.[0];
  expect(internalReleaseId).not.toBe("");
  expect(internalFingerprint).toBeTruthy();

  const organizerEmbedManager = page.getByTestId("embed-manager");
  await expect(organizerEmbedManager).toBeVisible();
  const organizerMode = organizerEmbedManager.getByLabel("Surface", { exact: true });
  const organizerTheme = organizerEmbedManager.getByLabel("Theme", { exact: true });
  const organizerAccent = organizerEmbedManager.getByLabel("Accent", { exact: true });
  const organizerSearch = organizerEmbedManager.getByLabel("Enable search controls", { exact: true });
  await organizerMode.selectOption(selectedMode);
  await organizerTheme.selectOption(selectedTheme);
  await organizerAccent.selectOption(selectedAccent);
  await organizerSearch.setChecked(selectedSearch);
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(page.getByTestId("embed-save-state")).toContainText("configuration saved");
  await page.reload();
  await expect(organizerEmbedManager).toBeVisible();
  await expect(page.getByText("1 event-scoped", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(organizerMode).toHaveValue(selectedMode);
  await expect(organizerTheme).toHaveValue(selectedTheme);
  await expect(organizerAccent).toHaveValue(selectedAccent);
  await expect(organizerSearch).toBeChecked({ checked: selectedSearch });

  const publicAgendaTarget = await followVisibleLink(
    page,
    page.getByRole("link", { name: "Open current public agenda", exact: true }),
  );
  expect(publicAgendaTarget.pathname).toMatch(/^\/events\/aud1-[0-9a-f-]+\/agenda$/u);
  expect(publicAgendaTarget.pathname).not.toContain(internalReleaseId);
  await expect(page.getByRole("link", { name: sessionTitle, exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(internalReleaseId);
  await expect(page.locator("body")).not.toContainText(internalFingerprint!);

  expect(health.serverErrors, "unexpected 5xx responses").toEqual([]);
  expect(health.pageErrors, "unexpected page errors").toEqual([]);
});

test("keeps portable entry controls accessible and unobscured at desktop and 390px", async ({ page }) => {
  await page.goto("/");
  const publicProgramHref = await page.getByRole("link", { name: "Open public program", exact: true }).getAttribute("href");
  if (!publicProgramHref) throw new Error("The public program entry is missing its href");

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(publicProgramHref);
    const attendeeEntry = page.getByRole("link", { name: "Open canonical attendee agenda", exact: true });
    const configureEmbed = page.getByRole("link", { name: "Configure portable embed", exact: true });
    await expectControlUnoccluded(attendeeEntry, `attendee agenda entry at ${viewport.width}px`);
    await expectControlUnoccluded(configureEmbed, `portable embed configuration at ${viewport.width}px`);
    await expectNoHorizontalOverflow(page, `portable public surface at ${viewport.width}px`);
    await expectNoSeriousAxeViolations(page, `portable public surface at ${viewport.width}px`);

    await openWidgetSurface(page, "Gallery");
    await expect(page.getByTestId("speaker-gallery").locator("[data-gallery-speaker-reference]").first()).toBeVisible();
    await expectNoHorizontalOverflow(page, `speaker gallery at ${viewport.width}px`);
    await expectNoSeriousAxeViolations(page, `speaker gallery at ${viewport.width}px`);

    await openWidgetSurface(page, "My itinerary");
    const emptyState = page.getByTestId("itinerary-empty");
    await expect(emptyState).toContainText("Your itinerary is empty.");
    await expect(page.getByRole("link", { name: /Download/u })).toHaveCount(0);
    await expectControlUnoccluded(emptyState.getByRole("button", { name: "Browse published sessions", exact: true }), `empty itinerary action at ${viewport.width}px`);
    await expectNoHorizontalOverflow(page, `empty itinerary at ${viewport.width}px`);
    await expectNoSeriousAxeViolations(page, `empty itinerary at ${viewport.width}px`);
  }
});
