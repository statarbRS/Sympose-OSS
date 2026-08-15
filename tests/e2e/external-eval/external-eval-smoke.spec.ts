import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const smokeFixture = JSON.parse(
  readFileSync(resolve("tests/fixtures/external-eval/browser-smoke.json"), "utf8"),
) as {
  startPath: string;
  login: {
    organizerDisplayName: string;
    workspaceSlug: string;
  };
  event: {
    name: string;
    programUnitName: string;
    capacity: string;
  };
  stages: Array<{
    id: string;
    button?: string;
    expectedText: string | string[];
  }>;
};

type SmokeStage = (typeof smokeFixture.stages)[number];

function getStage(id: string): SmokeStage {
  const stage = smokeFixture.stages.find((candidate) => candidate.id === id);
  if (!stage) {
    throw new Error(`Missing smoke stage: ${id}`);
  }
  return stage;
}

test("walks the local Phase 0 surface from the public root", async ({ page }) => {
  await page.goto(smokeFixture.startPath);

  const rootStage = getStage("root");
  const rootText = Array.isArray(rootStage.expectedText)
    ? rootStage.expectedText
    : [rootStage.expectedText];
  for (const expectedText of rootText) {
    await expect(page.getByText(expectedText, { exact: false }).first()).toBeVisible();
  }

  const organizerChoice = page
    .locator("label.login-option")
    .filter({ hasText: smokeFixture.login.organizerDisplayName })
    .getByRole("radio");
  await expect(organizerChoice).toBeVisible();
  await organizerChoice.check();
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page).toHaveURL(new RegExp("/w/" + smokeFixture.login.workspaceSlug + "/dashboard$"), {
    timeout: 30_000,
  });

  // Keep this harness traversal read-only so it can share a clean E2E database with the
  // stateful golden path. The golden path below proves each mutation and immutable receipt.
  const evaluatorDisclosure = page.getByTestId("evaluator-disclosure");
  const evaluatorSummary = evaluatorDisclosure
    .locator("summary")
    .filter({ hasText: "Evaluator controls · supporting workflow" });
  await expect(evaluatorSummary).toHaveCount(1);
  await evaluatorSummary.click();
  await expect(evaluatorDisclosure).toHaveAttribute("open", "");
  for (const stageId of ["import", "snapshot", "event", "compile", "approve"] as const) {
    const stage = getStage(stageId);
    if (!stage.button) throw new Error(`${stageId} smoke stage has no button`);
    await expect(evaluatorDisclosure.getByRole("button", { name: stage.button, exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("Event name")).toBeVisible();
  await expect(page.getByLabel("Program unit name")).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Capacity", exact: true })).toBeVisible();
});

test("exposes synthetic organizer, reviewer, applicant, and speaker entry points", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Evaluator persona entry points" })).toBeVisible();

  const applicantLink = page.getByRole("link", { name: "Open Stagecraft 2026 CFP" });
  await expect(applicantLink).toHaveAttribute("href", "/cfp/acme/stagecraft-2026");
  await Promise.all([
    page.waitForURL(/\/cfp\/acme\/stagecraft-2026$/),
    applicantLink.click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Stagecraft 2026 Call for Proposals", level: 1 }),
  ).toBeVisible();

  await page.goto("/");
  await page.getByRole("link", { name: "Open scoped speaker portal" }).click();
  await expect(page).toHaveURL(/\/speaker\/entry$/);
  await page.getByRole("button", { name: "Preview Priya’s speaker portal" }).click();
  await expect(page).toHaveURL(/\/speaker$/);
  await expect(page.getByRole("heading", { name: "Welcome, Priya Raman" })).toBeVisible();

  await page.goto("/");
  await Promise.all([
    page.waitForURL(/\/review\/acme\/queue$/, { timeout: 30_000 }),
    page.getByRole("button", { name: "Enter reviewer queue" }).click(),
  ]);
  await expect(page.getByTestId("reviewer-queue")).toContainText("Your review queue");
  await expect(page.getByTestId("reviewer-queue")).toContainText("Ready to review");
});
