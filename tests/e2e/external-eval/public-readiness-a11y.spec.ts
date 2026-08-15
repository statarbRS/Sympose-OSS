import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const AUDIENCE_REFERENCE_PATTERN = /^aud1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INTERNAL_PUBLIC_FIELD_PATTERN = /(?:workspaceId|eventId|releaseId|artifactId|personId|programUnitId|contentHash|fingerprint|sourcePlanVersionId|audiencePolicyVersion|commitmentWatermark|publication-release|public-event\/)/iu;

async function expectNoHighImpactAccessibilityViolations(page: Page, surface: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = result.violations.filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? ""),
  );
  expect(violations, `${surface} has critical or serious Axe violations`).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, surface: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth, `${surface} overflows horizontally`).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectNoInternalPublicSurface(
  value: string,
  surface: string,
  knownInternalValues: readonly string[] = [],
): Promise<void> {
  expect(value, `${surface} exposes a full release fingerprint`).not.toMatch(/[a-f0-9]{64}/iu);
  expect(value, `${surface} exposes an internal public field`).not.toMatch(INTERNAL_PUBLIC_FIELD_PATTERN);
  for (const knownInternalValue of knownInternalValues) {
    expect(knownInternalValue, `${surface} test fixture must contain a known internal value`).not.toBe("");
    expect(value, `${surface} exposes known internal value ${knownInternalValue}`).not.toContain(knownInternalValue);
  }
}

async function expectAnonymousPublicMarkupRedacted(
  page: Page,
  surface: string,
  knownInternalValues: readonly string[] = [],
): Promise<void> {
  const html = await page.content();
  const serializedClientProps = await page.evaluate(() => Array.from(document.scripts).map((script) => script.textContent ?? "").join("\n"));
  const browserState = await page.evaluate(() => JSON.stringify({ href: window.location.href, historyState: window.history.state }));
  await expectNoInternalPublicSurface(html, `${surface} complete HTML`, knownInternalValues);
  await expectNoInternalPublicSurface(serializedClientProps, `${surface} serialized client props`, knownInternalValues);
  await expectNoInternalPublicSurface(browserState, `${surface} URL/history state`, knownInternalValues);
}

async function signInAsOrganizer(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/");
  const organizerChoice = page
    .locator("label.login-option")
    .filter({ hasText: "Acme Organizer" })
    .getByRole("radio");
  await organizerChoice.check();
  await page.getByRole("button", { name: "Sign in to workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/dashboard$/u, { timeout: 20_000 });
}

async function readKnownInternalReleaseValues(page: Page): Promise<readonly string[]> {
  await signInAsOrganizer(page);
  await page.getByRole("link", { name: "Publication surface", exact: true }).click();
  await expect(page.getByTestId("durable-current-release")).toBeVisible({ timeout: 20_000 });
  const releaseId = (await page.getByTestId("durable-current-release").locator("code").innerText()).trim();
  const sourceText = await page.getByTestId("organizer-source-release").innerText();
  const fingerprint = sourceText.match(/[a-f0-9]{64}/iu)?.[0] ?? "";
  expect(fingerprint).not.toBe("");
  await page.context().clearCookies();
  return [releaseId, fingerprint];
}

test("landing and walkthrough stay accessible at desktop and 390px", async ({ page }) => {
  for (const viewport of [1440, 390]) {
    await page.setViewportSize({ width: viewport, height: viewport === 390 ? 844 : 900 });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "See how proposals become a published event program." })).toBeVisible();
    await expectNoHighImpactAccessibilityViolations(page, `landing at ${viewport}px`);
    if (viewport === 390) await expectNoHorizontalOverflow(page, "landing at 390px");

    await page.goto("/walkthrough");
    await expect(page.getByRole("heading", { name: "See the whole Sympose loop before you score it." })).toBeVisible();
    await expect(page).toHaveTitle("Evaluator walkthrough · Sympose");
    await expectNoHighImpactAccessibilityViolations(page, `walkthrough at ${viewport}px`);
    if (viewport === 390) await expectNoHorizontalOverflow(page, "walkthrough at 390px");
  }
});

test("the validated attendee agenda stays accessible at desktop and 390px", async ({ page }) => {
  const knownInternalValues = await readKnownInternalReleaseValues(page);
  for (const viewport of [1440, 390]) {
    await page.setViewportSize({ width: viewport, height: viewport === 390 ? 844 : 900 });
    await page.goto("/");
    await expectAnonymousPublicMarkupRedacted(page, `anonymous landing at ${viewport}px`, knownInternalValues);
    const attendeeLink = page.getByRole("link", { name: "Open current attendee agenda", exact: true }).first();
    const attendeeHref = await attendeeLink.getAttribute("href");
    expect(attendeeHref).toMatch(/^\/events\/aud1-[0-9a-f-]+\/agenda$/u);
    const redirectResponse = await page.request.get("/?attendee=agenda", { maxRedirects: 0 });
    expect([307, 308]).toContain(redirectResponse.status());
    const redirectLocation = redirectResponse.headers().location ?? "";
    expect(redirectLocation).toBe(attendeeHref);
    expect(redirectLocation).not.toMatch(/[a-f0-9]{64}/iu);
    await expectNoInternalPublicSurface(redirectLocation, "root redirect Location", knownInternalValues);
    await attendeeLink.click();
    await expect(page).toHaveURL(/\/events\/aud1-[0-9a-f-]+\/agenda$/u, { timeout: 20_000 });
    const publicEventReference = new URL(page.url()).pathname.split("/")[2] ?? "";
    expect(publicEventReference).toMatch(AUDIENCE_REFERENCE_PATTERN);
    await expect(page.getByRole("heading", { name: "Acme Evaluator Summit", level: 1 })).toBeVisible();
    await expect(page).toHaveTitle("Agenda · Sympose");
    await expectAnonymousPublicMarkupRedacted(page, `attendee agenda at ${viewport}px`, knownInternalValues);
    const rscResponse = await page.request.get(page.url(), {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    expect(rscResponse.ok()).toBe(true);
    await expectNoInternalPublicSurface(await rscResponse.text(), "standalone public agenda RSC", knownInternalValues);
    const unknownRoute = await page.request.get("/events/aud1-11111111-1111-4111-8111-111111111111/agenda");
    expect(unknownRoute.status()).toBe(404);
    const legacyFingerprintRoute = await page.request.get(`/events/${knownInternalValues[1]}/agenda`);
    expect(legacyFingerprintRoute.status()).toBe(404);
    if (viewport === 1440) {
      const feedResponse = await page.request.get(`/embed/${encodeURIComponent(publicEventReference)}/feed`);
      expect(feedResponse.ok()).toBe(true);
      const feed = await feedResponse.json() as Record<string, unknown>;
      expect(Object.keys(feed).sort()).toEqual([
        "channelReference",
        "event",
        "releaseNumber",
        "releaseReference",
        "sealedAt",
        "sessions",
        "speakers",
      ]);
      expect(feed).toMatchObject({
        channelReference: publicEventReference,
        releaseReference: publicEventReference,
        releaseNumber: 1,
        sealedAt: expect.any(String),
      });
      expect(Array.isArray(feed.event)).toBe(false);
      expect(Array.isArray(feed.sessions)).toBe(true);
      expect(Array.isArray(feed.speakers)).toBe(true);
      expect(JSON.stringify(feed)).not.toMatch(/"(?:schema|contentHash|releaseId|artifactId|personId|programUnitId|fingerprint|sourcePlanVersionId|audiencePolicyVersion|commitmentWatermark|workspaceId|eventId)"\s*:/iu);
      expect(JSON.stringify(feed)).not.toMatch(/release-synthetic-public-v1|synthetic-public-release-fingerprint-v1/iu);
      await expectNoInternalPublicSurface(JSON.stringify(feed), "public feed JSON", knownInternalValues);
    }

    if (viewport === 1440) {
      const firstSessionLink = page.locator('main a[href^="sessions/"]').first();
      await expect(firstSessionLink).toBeVisible();
      const firstSessionHref = await firstSessionLink.getAttribute("href");
      expect(firstSessionHref).toMatch(/^sessions\/aud1-[0-9a-f-]+$/u);
      expect(firstSessionHref).not.toMatch(INTERNAL_PUBLIC_FIELD_PATTERN);
      await Promise.all([
        page.waitForURL(/\/events\/aud1-[0-9a-f-]+\/sessions\/aud1-[0-9a-f-]+$/u, { timeout: 20_000 }),
        firstSessionLink.click(),
      ]);
      await expectAnonymousPublicMarkupRedacted(page, "public session detail", knownInternalValues);
      const firstSpeakerLink = page.locator('main a[href^="../speakers/"]').first();
      const firstSpeakerHref = await firstSpeakerLink.getAttribute("href");
      expect(firstSpeakerHref).toMatch(/^\.\.\/speakers\/aud1-[0-9a-f-]+$/u);
      await expect(page.locator('main a[href^="../speakers/"]').first()).toBeVisible();
      const backLink = page.getByRole("link", { name: /Back to agenda/u });
      await expect(backLink).toHaveAttribute("href", "../agenda");
      await backLink.click();
      await expect(page).toHaveURL(/\/events\/aud1-[0-9a-f-]+\/agenda$/u);
      const saveButton = page.getByRole("button", { name: /Save$/u }).first();
      await expect(saveButton).toBeVisible();
      await saveButton.click();
      await expect(page.getByRole("button", { name: /Saved/u }).first()).toBeVisible();
      const storageAfterItinerary = await page.evaluate(() => JSON.stringify({
        local: Object.fromEntries(Object.entries(localStorage)),
        session: Object.fromEntries(Object.entries(sessionStorage)),
      }));
      expect(storageAfterItinerary).toContain(`sympose:public-itinerary:${publicEventReference}`);
      expect(storageAfterItinerary).not.toMatch(/demo-public|workspace-synthetic-public|browser-public/iu);
      await expectNoInternalPublicSurface(storageAfterItinerary, "itinerary browser storage", knownInternalValues);
    }
    await expectNoHighImpactAccessibilityViolations(page, `attendee agenda at ${viewport}px`);
    if (viewport === 390) await expectNoHorizontalOverflow(page, "attendee agenda at 390px");
  }
});

test("organizer readiness stays accessible and fail-closed at desktop and 390px", async ({ page }) => {
  for (const viewport of [1440, 390]) {
    await page.setViewportSize({ width: viewport, height: viewport === 390 ? 844 : 900 });
    await signInAsOrganizer(page);
    await page.getByRole("link", { name: "Open event overview", exact: true }).first().click();
    await expect(page).toHaveURL(/\/w\/[^/]+\/events\/[^/]+\/overview$/u, { timeout: 20_000 });
    await page.getByRole("link", { name: "Readiness", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Readiness command center", level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveTitle("Event readiness · Sympose", { timeout: 20_000 });
    await expect(page.getByText("Cannot verify", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expectNoHighImpactAccessibilityViolations(page, `readiness at ${viewport}px`);
    if (viewport === 390) await expectNoHorizontalOverflow(page, "readiness at 390px");
  }
});
