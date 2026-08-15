import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createSession, resolveSession, SESSION_COOKIE } from "../../src/server/auth";
import { closeDb, openDb } from "../../src/server/db";
import {
  createProgramCapacityPool,
  transferProgramCapacity,
} from "../../src/server/services/program-capacity";

const DATABASE_PATH = resolve(".tmp/e2e/sympose.db");

async function expectNoHorizontalDocumentOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectNoHighImpactAccessibilityViolations(page: Page): Promise<void> {
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

function createNorthstarOrganizerSession(): {
  readonly token: string;
  readonly workspaceId: string;
} {
  const db = openDb({ path: DATABASE_PATH });
  try {
    const organizer = db.prepare(
      `SELECT a.id AS accountId, a.workspace_id AS workspaceId
         FROM accounts a
         JOIN workspaces w ON w.id = a.workspace_id
        WHERE w.slug = 'northstar' AND a.role = 'organizer'
        ORDER BY a.id
        LIMIT 1`,
    ).get() as { accountId: string; workspaceId: string } | undefined;
    if (!organizer) throw new Error("missing synthetic Northstar organizer");
    return {
      token: createSession(db, organizer.accountId, organizer.workspaceId).token,
      workspaceId: organizer.workspaceId,
    };
  } finally {
    closeDb(db);
  }
}

async function useWorkspaceSession(
  context: BrowserContext,
  origin: string,
  token: string,
): Promise<void> {
  await context.addCookies([{
    name: SESSION_COOKIE,
    value: token,
    url: origin,
    httpOnly: true,
    sameSite: "Lax",
  }]);
}

async function createAcceptedSessionThroughExistingActions(
  page: Page,
  context: BrowserContext,
): Promise<{ readonly eventName: string; readonly planPath: string; readonly token: string }> {
  const session = createNorthstarOrganizerSession();
  await page.goto("/");
  await useWorkspaceSession(context, new URL(page.url()).origin, session.token);
  await page.goto("/w/northstar/dashboard");
  await page.getByTestId("evaluator-disclosure").locator("summary").click();

  const importCard = page.getByRole("region", { name: "Import provider evidence" });
  await importCard.getByRole("button", { name: "Import fixture evidence" }).click();
  await expect(importCard.getByRole("status")).toContainText(/Imported|already/u);

  const snapshotCard = page.getByRole("region", { name: "Freeze cohort snapshot" });
  await snapshotCard.getByRole("button", { name: "Freeze snapshot" }).click();
  await expect(snapshotCard.getByRole("status")).toContainText(/Frozen cohort snapshot|already frozen/u);

  const suffix = randomUUID().slice(0, 8);
  const eventName = `Capacity Flight Deck ${suffix}`;
  const eventCard = page.getByRole("region", { name: "Create event and program unit" });
  await eventCard.getByLabel("Event name").fill(eventName);
  await eventCard.getByLabel("Program unit name").fill("Accepted capacity session");
  await eventCard.getByLabel("Capacity").fill("6");
  await eventCard.getByRole("button", { name: "Create event" }).click();
  await expect(eventCard.getByRole("status")).toContainText(`Created event "${eventName}"`);

  const compileCard = page.getByRole("region", { name: "Compile candidate plan" });
  await compileCard.getByRole("button", { name: "Compile plan" }).click();
  await expect(compileCard.getByRole("status")).toContainText("Compiled candidate plan v1");

  const approvalCard = page.getByRole("region", { name: "Approve plan (separate decision)" });
  await approvalCard.getByRole("button", { name: "Approve candidate plan" }).click();
  await expect(approvalCard.getByRole("status")).toContainText("Plan approved");

  const offersCard = page.getByRole("region", { name: "Deliver exact offers" });
  await offersCard.getByRole("button", { name: "Deliver offers" }).click();
  await expect(offersCard.getByRole("status")).toContainText("Delivered 6 exact offer envelopes");

  const acceptanceCard = page.getByRole("region", { name: "Simulate one acceptance" });
  await acceptanceCard.getByRole("button", { name: "Simulate one acceptance" }).click();
  await expect(acceptanceCard.getByRole("status")).toContainText("Person accepted the exact offer");

  const planPath = await page.getByRole("link", { name: "Review immutable plan and explanations" }).getAttribute("href");
  if (!planPath) throw new Error("missing Plan Studio path after approval");
  return { eventName, planPath, token: session.token };
}

function appendConservedCapacity(input: {
  readonly eventName: string;
  readonly token: string;
}): void {
  const db = openDb({ path: DATABASE_PATH });
  try {
    const session = resolveSession(db, input.token);
    if (!session) throw new Error("missing organizer session for capacity fixture");
    const event = db.prepare(
      "SELECT id, starts_at AS startsAt FROM events WHERE workspace_id = ? AND name = ? LIMIT 1",
    ).get(session.workspaceId, input.eventName) as { id: string; startsAt: string } | undefined;
    if (!event) throw new Error("missing capacity event fixture");

    const suffix = event.id.replaceAll(/[^A-Za-z0-9]/gu, "").slice(0, 12);
    const main = createProgramCapacityPool(db, session, event.id, {
      poolId: `flight-main-${suffix}`,
      versionId: `flight-main-${suffix}-v1`,
      name: "Main audience",
      unitKind: "SEAT",
      capacity: 4,
      effectiveFrom: event.startsAt,
    });
    const reserve = createProgramCapacityPool(db, session, event.id, {
      poolId: `flight-reserve-${suffix}`,
      versionId: `flight-reserve-${suffix}-v1`,
      name: "Access reserve",
      unitKind: "SEAT",
      capacity: 1,
      effectiveFrom: event.startsAt,
    });
    transferProgramCapacity(db, session, event.id, {
      sourcePoolId: main.pool.id,
      destinationPoolId: reserve.pool.id,
      unitKind: "SEAT",
      quantity: 1,
      reason: "Protect access reserve",
      approvalReference: `flight-approval-${suffix}`,
      idempotencyKey: `flight-transfer-${suffix}`,
    });
  } finally {
    closeDb(db);
  }
}

async function sourceFingerprintTitles(page: Page): Promise<{
  readonly ledger: string | null;
  readonly inventory: string | null;
  readonly plan: string | null;
}> {
  const deck = page.getByTestId("capacity-flight-deck");
  return {
    ledger: await deck.getByTestId("capacity-ledger-fingerprint").locator(".fp").getAttribute("title"),
    inventory: await deck.getByTestId("accepted-inventory-fingerprint").locator(".fp").getAttribute("title"),
    plan: await deck.getByTestId("plan-source-fingerprint").locator(".fp").getAttribute("title"),
  };
}

test("Capacity Flight Deck preserves empty, over, receipt, reload, and responsive truth", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await createAcceptedSessionThroughExistingActions(page, context);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(fixture.planPath);
  const deck = page.getByTestId("capacity-flight-deck");
  const seatLane = deck.locator('[data-testid="capacity-pool-type"][data-unit-kind="SEAT"]');
  await expect(deck).toBeVisible();
  await expect(deck.getByTestId("capacity-empty-state")).toContainText("No conserved capacity pools exist");
  await expect(seatLane).toHaveAttribute("data-state", "over");
  await expect(seatLane).toContainText("6 demand uncovered by conserved pools");
  await expect(seatLane).not.toContainText("6 over capacity");
  await expect(deck).toContainText("Accepted capacity session");
  await expectNoHorizontalDocumentOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("capacity-flight-deck-empty-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(deck).toBeVisible();
  await expect(seatLane).toContainText("6 demand uncovered by conserved pools");
  await expect(seatLane).not.toContainText("6 over capacity");
  await expectNoHorizontalDocumentOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("capacity-flight-deck-empty-mobile-390.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  appendConservedCapacity(fixture);
  await page.reload();
  await expect(deck).toHaveAttribute("data-capacity-sequence", "1");
  await expect(deck.getByTestId("capacity-empty-state")).toHaveCount(0);
  await expect(seatLane).toContainText("1 over capacity");
  await expect(seatLane).not.toContainText("demand uncovered by conserved pools");
  await expect(seatLane).toContainText("Main audience");
  await expect(seatLane).toContainText("Access reserve");
  await expect(deck).toContainText("Protect access reserve");
  await expect(deck).toContainText("1 receipt");
  await expectNoHorizontalDocumentOverflow(page);
  await expectNoHighImpactAccessibilityViolations(page);
  const sourceFingerprints = await sourceFingerprintTitles(page);
  expect(sourceFingerprints.ledger).toMatch(/[a-f0-9]{64}$/u);
  expect(sourceFingerprints.inventory).toMatch(/[a-f0-9]{64}$/u);
  expect(sourceFingerprints.plan).toMatch(/[a-f0-9]{64}$/u);
  await page.screenshot({ path: testInfo.outputPath("capacity-flight-deck-populated-desktop.png"), fullPage: true });

  await page.reload();
  await expect(deck).toHaveAttribute("data-capacity-sequence", "1");
  expect(await sourceFingerprintTitles(page)).toEqual(sourceFingerprints);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(deck).toBeVisible();
  await expect(seatLane).toContainText("1 over capacity");
  await expectNoHorizontalDocumentOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("capacity-flight-deck-mobile-390.png"), fullPage: true });

  await page.goto(fixture.planPath.replace(/\/plan$/u, "/program"));
  await expect(page.getByTestId("capacity-flight-deck")).toContainText("Protect access reserve");
  await expect(page.getByRole("heading", { name: "Plan Studio", level: 1 })).toBeVisible();
  await expectNoHorizontalDocumentOverflow(page);
});
