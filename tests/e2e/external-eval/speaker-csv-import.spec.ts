import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const speakerFixture = resolve("tests/fixtures/external-eval/speakers.csv");

test("organizer imports the evaluator speaker CSV and the roster survives reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Evaluator persona entry points", level: 2 }),
  ).toBeVisible();

  const organizerChoice = page
    .locator("label.login-option")
    .filter({ hasText: "Acme Organizer" })
    .getByRole("radio");
  await expect(organizerChoice).toBeVisible();
  await organizerChoice.check();
  await page.getByRole("button", { name: "Sign in to workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/dashboard$/u);

  const speakerSurface = page.getByRole("link", { name: "Speaker surface", exact: true });
  await expect(speakerSurface).toBeVisible();
  await speakerSurface.click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/events\/[^/]+\/speakers$/u);
  await expect(
    page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 }),
  ).toBeVisible();

  const speakerRoster = page
    .getByRole("table", {
      name: "Canonical people with event-scoped speaker and moderator projections",
    });
  const danaRow = speakerRoster.getByRole("row").filter({ hasText: "Dana Kowalski" });
  await expect(danaRow).toHaveCount(0);

  const csvImport = page.locator('section[aria-labelledby="speaker-csv-import-title"]');
  await expect(csvImport).toContainText("name,email,title,company,bio");
  const csvFileInput = csvImport.getByLabel("CSV file", { exact: true });
  await expect(csvFileInput).toBeVisible();
  await csvFileInput.setInputFiles(speakerFixture);
  await csvImport
    .getByRole("button", { name: "Import or merge speakers", exact: true })
    .click();

  await expect(csvImport.getByRole("status").filter({ hasText: "Import receipt" })).toContainText(
    "Processed 3 row(s)",
  );
  await expect(csvImport.getByRole("status").filter({ hasText: "Import receipt" })).toContainText(
    "email sent: false · file bytes stored: false",
  );
  await expect(speakerRoster).toBeVisible();
  await expect(danaRow).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 }),
  ).toBeVisible();
  await expect(danaRow).toBeVisible();
});
