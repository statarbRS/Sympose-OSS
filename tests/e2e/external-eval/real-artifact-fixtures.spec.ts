import { createHash } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";

const HEADSHOT_FIXTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACAElEQVR42u3TQQ0AAAjEsFOHCDQhmjcaaFIFS5bqgbciAQYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABMIAKGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAbAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAGUAEDgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwAFwLUysRleTQrvsAAAAASUVORK5CYII=", "base64");
const SLIDES_FIXTURE = Buffer.from("JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2NSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoRGV2RmxvdyBDb25mIDIwMjcgLSBTYW1wbGUgU2xpZGVzKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM1NSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQyNQolJUVPRgo=", "base64");

const REPLACEMENT_HEADSHOT_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function openOrganizerSpeakerSurface(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Evaluator persona entry points", level: 2 })).toBeVisible();

  await page.locator("label.login-option").filter({ hasText: "Acme Organizer" }).getByRole("radio").check();
  await page.getByRole("button", { name: "Sign in to workspace", exact: true }).click();
  await page.waitForURL((url) => /^\/w\/[^/]+\/dashboard$/u.test(url.pathname));

  const speakerLink = page.getByRole("link", { name: "Speaker surface", exact: true });
  const speakerHref = await speakerLink.getAttribute("href");
  if (!speakerHref) throw new Error("The organizer dashboard did not expose the Speaker surface URL");
  await page.goto(speakerHref);
  await expect(page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 })).toBeVisible();
}

function minaRosterRow(page: Page): Locator {
  return page
    .getByRole("table", { name: "Canonical people with event-scoped speaker and moderator projections" })
    .locator("tbody tr")
    .filter({ hasText: "Mina Park" })
    .first();
}

async function openMinaPortal(page: Page): Promise<void> {
  const mina = minaRosterRow(page);
  await expect(mina).toBeVisible();
  await mina.getByRole("button", { name: "Open local preview", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/speaker");
  await expect(page.getByRole("heading", { name: "Welcome, Mina Park", level: 1 })).toBeVisible();
}

function taskCard(page: Page, title: string): Locator {
  return page.locator('section[aria-labelledby="tasks-title"] article').filter({ has: page.getByRole("heading", { name: title, exact: true }) }).first();
}

async function uploadVersion(card: Locator, fixture: { readonly buffer: Buffer; readonly mimeType: string; readonly name: string }): Promise<void> {
  await card.locator('input[name="artifactFile"]').setInputFiles(fixture);
  await card.getByRole("button", { name: "Submit new immutable version", exact: true }).click();
}

async function browserFetch(page: Page, href: string): Promise<{
  readonly bytes: Buffer;
  readonly contentDisposition: string;
  readonly mediaType: string;
  readonly status: number;
}> {
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "same-origin" });
    const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
    return {
      bytes,
      contentDisposition: response.headers.get("content-disposition") ?? "",
      mediaType: response.headers.get("content-type") ?? "",
      status: response.status,
    };
  }, new URL(href, page.url()).toString());
  return {
    ...result,
    bytes: Buffer.from(result.bytes),
  };
}

test.describe("real artifact fixture browser proof", () => {
  test.setTimeout(240_000);

  test("persists, versions, downloads, approves, and safely publishes real evaluator files", async ({ browser, page }) => {
    const expectedHeadshot = HEADSHOT_FIXTURE;
    const expectedReplacementHeadshot = REPLACEMENT_HEADSHOT_FIXTURE;
    const expectedSlides = SLIDES_FIXTURE;
    expect(sha256(expectedHeadshot)).toBe("9727e98b19375716494cffa46f09edc60624d8a381199cc63a420a6c0f7174fc");
    expect(sha256(expectedReplacementHeadshot)).toBe("431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460");
    expect(sha256(expectedSlides)).toBe("a05e7a2b13c6f9d34de76c2d5a32b160faf7cd19537e3173833937ef652d66cb");

    await openOrganizerSpeakerSurface(page);
    await openMinaPortal(page);

    let headshot = taskCard(page, "Headshot PNG");
    let slides = taskCard(page, "Slides or supporting PDF");
    await expect(headshot).toContainText("image/png only · maximum 8 MiB");
    await expect(slides).toContainText("application/pdf only · maximum 25 MiB");
    await expect(headshot.getByText(/headshot\.png · v1 · .* · current/u)).toBeVisible();
    await expect(slides.getByText(/slides\.pdf · v1 · .* · current/u)).toBeVisible();

    const privateSlidesHref = await slides
      .getByRole("link", { name: "slides.pdf", exact: true })
      .last()
      .getAttribute("href");
    if (!privateSlidesHref) throw new Error("The seeded speaker slides did not expose an authenticated download URL");
    const speakerSlides = await browserFetch(page, privateSlidesHref);
    expect(speakerSlides.status).toBe(200);
    expect(speakerSlides.mediaType).toContain("application/pdf");
    expect(speakerSlides.bytes).toEqual(expectedSlides);

    await uploadVersion(headshot, { buffer: HEADSHOT_FIXTURE, mimeType: "image/png", name: "headshot.png" });
    headshot = taskCard(page, "Headshot PNG");
    await expect(headshot.getByText(/headshot\.png · v1 · .* · superseded/u)).toBeVisible();
    await expect(headshot.getByText(/headshot\.png · v2 · .* · current/u)).toBeVisible();

    await uploadVersion(slides, { buffer: SLIDES_FIXTURE, mimeType: "application/pdf", name: "slides.pdf" });
    slides = taskCard(page, "Slides or supporting PDF");
    await expect(slides.getByText(/slides\.pdf · v1 · .* · superseded/u)).toBeVisible();
    await expect(slides.getByText(/slides\.pdf · v2 · .* · current/u)).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Welcome, Mina Park", level: 1 })).toBeVisible();
    await expect(taskCard(page, "Headshot PNG").getByText(/headshot\.png · v1 · .* · superseded/u)).toBeVisible();
    await expect(taskCard(page, "Headshot PNG").getByText(/headshot\.png · v2 · .* · current/u)).toBeVisible();
    await expect(taskCard(page, "Slides or supporting PDF").getByText(/slides\.pdf · v1 · .* · superseded/u)).toBeVisible();
    await expect(taskCard(page, "Slides or supporting PDF").getByText(/slides\.pdf · v2 · .* · current/u)).toBeVisible();

    await page.getByRole("button", { name: "Close portal", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/speaker/entry");
    await page.goto("/");
    await page.waitForURL((url) => /^\/w\/[^/]+\/dashboard$/u.test(url.pathname));
    const speakerHref = await page.getByRole("link", { name: "Speaker surface", exact: true }).getAttribute("href");
    const initialPublicWidgetsHref = await page.getByRole("link", { name: "Public widgets", exact: true }).getAttribute("href");
    if (!speakerHref) throw new Error("The organizer dashboard lost its Speaker surface URL");
    if (!initialPublicWidgetsHref || !/^\/embed\/aud1-[0-9a-f-]+$/u.test(initialPublicWidgetsHref)) {
      throw new Error("The organizer dashboard did not expose an opaque public widget URL");
    }
    const initialPublicChannelReference = initialPublicWidgetsHref.split("/").at(-1) ?? "";
    await page.goto(speakerHref);

    const mina = minaRosterRow(page);
    await mina.getByText("Exact assignment and delivery evidence", { exact: true }).click();
    const organizerHeadshot = mina.getByRole("link", { name: "headshot.png", exact: true }).last();
    const organizerSlides = mina.getByRole("link", { name: "slides.pdf", exact: true }).last();
    await expect(organizerHeadshot).toBeVisible();
    await expect(organizerSlides).toBeVisible();
    const organizerHeadshotHref = await organizerHeadshot.getAttribute("href");
    const organizerSlidesHref = await organizerSlides.getAttribute("href");
    if (!organizerHeadshotHref || !organizerSlidesHref) throw new Error("Organizer artifact links were missing href values");
    const internalArtifactId = new URL(organizerHeadshotHref, page.url()).pathname.split("/").at(-1) ?? "";
    expect(internalArtifactId).not.toBe("");

    const [downloadedHeadshot, downloadedSlides] = await Promise.all([
      browserFetch(page, organizerHeadshotHref),
      browserFetch(page, organizerSlidesHref),
    ]);
    expect(downloadedHeadshot.status).toBe(200);
    expect(downloadedHeadshot.mediaType).toContain("image/png");
    expect(downloadedHeadshot.contentDisposition).toContain('filename="headshot.png"');
    expect(downloadedHeadshot.bytes).toEqual(expectedHeadshot);
    expect(downloadedSlides.status).toBe(200);
    expect(downloadedSlides.mediaType).toContain("application/pdf");
    expect(downloadedSlides.contentDisposition).toContain('filename="slides.pdf"');
    expect(downloadedSlides.bytes).toEqual(expectedSlides);

    const publicationHref = new URL(speakerHref.replace(/\/speakers$/u, "/publication"), page.url()).toString();
    await page.goto(publicationHref);
    const releasePointer = page.getByTestId("durable-current-release").locator("code");
    const priorReleaseId = (await releasePointer.innerText()).trim();
    await page.getByText("Validate current authoritative inputs", { exact: true }).click();
    await page.getByRole("button", { name: "Check and seal exact current inputs", exact: true }).click();
    await expect(page.getByText(
      "Every required publication artifact must have one current committed byte-verified version with exact publication approval.",
      { exact: true },
    )).toBeVisible();
    await expect(releasePointer).toHaveText(priorReleaseId);

    await page.goto(speakerHref);
    const reviewCard = page
      .getByRole("heading", { name: "Mina Park · Headshot PNG", exact: true, level: 3 })
      .locator("xpath=ancestor::article[1]");
    await expect(reviewCard).toContainText("Version 1");
    await expect(reviewCard).toContainText("Version 2");
    await reviewCard.getByRole("button", { name: "Approve exact version", exact: true }).click();
    await expect(reviewCard).toContainText("APPROVED");

    // Approval is decision truth, not publication. Seal a new immutable release before expecting
    // the newly approved headshot to appear on an anonymous surface.
    await page.goto(publicationHref);
    await page.getByText("Validate current authoritative inputs", { exact: true }).click();
    await page.getByRole("button", { name: "Check and seal exact current inputs", exact: true }).click();
    await expect(page.getByText("The approved plan was sealed as the event's durable current release.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("publication-seal-receipt")).toBeVisible();
    await page.getByRole("link", { name: "Review current release", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Current durable event projection", level: 1 })).toBeVisible();
    await expect.poll(async () => (await releasePointer.innerText()).trim()).not.toBe(priorReleaseId);

    await page.goto("/");
    await page.waitForURL((url) => /^\/w\/[^/]+\/dashboard$/u.test(url.pathname));
    const publicWidgetsHref = await page.getByRole("link", { name: "Public widgets", exact: true }).getAttribute("href");
    if (!publicWidgetsHref || !/^\/embed\/aud1-[0-9a-f-]+$/u.test(publicWidgetsHref)) {
      throw new Error("The newly sealed release did not expose an opaque public widget URL");
    }
    const publicChannelReference = publicWidgetsHref.split("/").at(-1) ?? "";
    expect(publicChannelReference).not.toBe(initialPublicChannelReference);

    const anonymous = await browser.newContext();
    const anonymousPage = await anonymous.newPage();
    const origin = new URL(page.url()).origin;
    const privateSlides = await anonymous.request.get(new URL(privateSlidesHref, origin).toString());
    expect(privateSlides.status()).toBe(404);
    const supersededWidget = await anonymous.request.get(
      new URL(`/embed/${encodeURIComponent(initialPublicChannelReference)}`, origin).toString(),
    );
    expect(supersededWidget.status()).toBe(404);
    const currentWidget = await anonymous.request.get(
      new URL(`/embed/${encodeURIComponent(publicChannelReference)}`, origin).toString(),
    );
    expect(currentWidget.status()).toBe(200);

    const savedConfiguration = await page.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Evaluator artifact fixture speakers",
          configuration: { mode: "speakers", theme: "light", accent: "teal", search: true },
          idempotencyKey: "evaluator-artifact-fixture-public-speakers",
        }),
      });
      const body = await response.json() as { configuration?: { id?: unknown } };
      return {
        status: response.status,
        configurationId: typeof body.configuration?.id === "string" ? body.configuration.id : null,
      };
    }, new URL(speakerHref.replace(/\/speakers$/u, "/publication/embed-config"), origin).toString());
    expect(savedConfiguration.status).toBe(201);
    if (!savedConfiguration.configurationId) throw new Error("The authenticated publication route did not persist a public configuration");
    const configurationQuery = `?configId=${encodeURIComponent(savedConfiguration.configurationId)}`;
    const publishedSpeakersHref = `/embed/${encodeURIComponent(publicChannelReference)}/speakers${configurationQuery}`;

    await anonymousPage.goto(new URL(publishedSpeakersHref, origin).toString());
    const publicSpeaker = anonymousPage.getByTestId("speaker-directory").locator("article").filter({ hasText: "Mina Park" }).first();
    const publicImage = publicSpeaker.getByRole("img", { name: "Mina Park photo", exact: true });
    await expect(publicImage).toBeVisible();
    await expect(publicSpeaker.getByText("slides.pdf", { exact: true })).toHaveCount(0);
    const publicImageHref = await publicImage.getAttribute("src");
    if (!publicImageHref) throw new Error("The sealed public speaker directory did not expose Mina's approved headshot URL");
    expect(publicImageHref).toMatch(/\/public\/releases\/aud1-[0-9a-f-]+\/speaker-artifacts\/aud1-[0-9a-f-]+$/u);
    expect(publicImageHref).not.toContain(internalArtifactId);
    expect(publicImageHref).not.toMatch(/[a-f0-9]{64}/iu);
    await anonymousPage.reload();
    await expect(anonymousPage.getByRole("img", { name: "Mina Park photo", exact: true })).toBeVisible();
    const publicHeadshot = await anonymous.request.get(new URL(publicImageHref, origin).toString());
    expect(publicHeadshot.status()).toBe(200);
    expect(publicHeadshot.headers()["content-type"]).toContain("image/png");
    const publicHeadshotBytes = Buffer.from(await publicHeadshot.body());
    expect(publicHeadshotBytes).toEqual(expectedHeadshot);
    console.log(`BINARY_EVIDENCE status=${publicHeadshot.status()} mediaType=${publicHeadshot.headers()["content-type"]} bytes=${publicHeadshotBytes.byteLength} sha256=${sha256(publicHeadshotBytes)}`);
    expect(publicHeadshot.headers()["cache-control"]).toBe("no-store");

    // A second approved headshot seal proves authority changes end to end: the old saved embed and
    // old photo route become anonymous 404s while organizer history and the new public photo remain.
    await page.goto(speakerHref);
    await openMinaPortal(page);
    await uploadVersion(taskCard(page, "Headshot PNG"), {
      buffer: expectedReplacementHeadshot,
      mimeType: "image/png",
      name: "headshot-current.png",
    });
    await expect(taskCard(page, "Headshot PNG").getByText(/headshot-current\.png · v3 · .* · current/u)).toBeVisible();
    await page.getByRole("button", { name: "Close portal", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/speaker/entry");
    await page.goto(speakerHref);
    const replacementReviewCard = page
      .getByRole("heading", { name: "Mina Park · Headshot PNG", exact: true, level: 3 })
      .locator("xpath=ancestor::article[1]");
    await expect(replacementReviewCard).toContainText("Version 3");
    await replacementReviewCard.getByRole("button", { name: "Approve exact version", exact: true }).click();
    await expect(replacementReviewCard).toContainText("APPROVED");

    await page.goto(new URL(speakerHref.replace(/\/speakers$/u, "/publication"), origin).toString());
    const replacementReleasePointer = page.getByTestId("durable-current-release").locator("code");
    const supersededReleaseId = (await replacementReleasePointer.innerText()).trim();
    await page.getByText("Validate current authoritative inputs", { exact: true }).click();
    await page.getByRole("button", { name: "Check and seal exact current inputs", exact: true }).click();
    await expect(page.getByText("The approved plan was sealed as the event's durable current release.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("publication-seal-receipt")).toBeVisible();
    await page.getByRole("link", { name: "Review current release", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Current durable event projection", level: 1 })).toBeVisible();
    await expect.poll(async () => (await replacementReleasePointer.innerText()).trim()).not.toBe(supersededReleaseId);

    await page.goto("/");
    await page.waitForURL((url) => /^\/w\/[^/]+\/dashboard$/u.test(url.pathname));
    const replacementWidgetsHref = await page.getByRole("link", { name: "Public widgets", exact: true }).getAttribute("href");
    if (!replacementWidgetsHref || !/^\/embed\/aud1-[0-9a-f-]+$/u.test(replacementWidgetsHref)) {
      throw new Error("The replacement headshot release did not expose an opaque public widget URL");
    }
    const replacementChannelReference = replacementWidgetsHref.split("/").at(-1) ?? "";
    expect(replacementChannelReference).not.toBe(publicChannelReference);

    const supersededBare = await anonymous.request.get(new URL(`/embed/${encodeURIComponent(publicChannelReference)}`, origin).toString());
    const supersededSavedConfigurationRoot = await anonymous.request.get(
      new URL(`/embed/${encodeURIComponent(publicChannelReference)}${configurationQuery}`, origin).toString(),
    );
    const supersededSavedConfigurationSurface = await anonymous.request.get(new URL(publishedSpeakersHref, origin).toString());
    const supersededHeadshot = await anonymous.request.get(new URL(publicImageHref, origin).toString());
    expect(supersededBare.status()).toBe(404);
    expect(supersededSavedConfigurationRoot.status()).toBe(404);
    expect(supersededSavedConfigurationSurface.status()).toBe(404);
    expect(supersededHeadshot.status()).toBe(404);
    expect(supersededHeadshot.headers()["cache-control"]).toBe("no-store");
    expect(await supersededHeadshot.text()).toBe("Not found");

    const replacementBare = await anonymous.request.get(new URL(replacementWidgetsHref, origin).toString());
    expect(replacementBare.status()).toBe(200);
    await anonymousPage.goto(new URL(`/embed/${encodeURIComponent(replacementChannelReference)}/speakers`, origin).toString());
    const replacementPublicSpeaker = anonymousPage.getByTestId("speaker-directory").locator("article").filter({ hasText: "Mina Park" }).first();
    const replacementPublicImage = replacementPublicSpeaker.getByRole("img", { name: "Mina Park photo", exact: true });
    await expect(replacementPublicImage).toBeVisible();
    const replacementPublicImageHref = await replacementPublicImage.getAttribute("src");
    if (!replacementPublicImageHref) throw new Error("The replacement release did not expose Mina's current headshot URL");
    expect(replacementPublicImageHref).not.toBe(publicImageHref);
    const replacementPublicHeadshot = await anonymous.request.get(new URL(replacementPublicImageHref, origin).toString());
    expect(replacementPublicHeadshot.status()).toBe(200);
    expect(replacementPublicHeadshot.headers()["cache-control"]).toBe("no-store");
    expect(Buffer.from(await replacementPublicHeadshot.body())).toEqual(expectedReplacementHeadshot);
    await anonymous.close();
  });
});
