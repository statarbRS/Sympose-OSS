import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { resolve } from "node:path";

import { createSession, SESSION_COOKIE } from "../../src/server/auth";
import { deterministicUuid } from "../../src/server/canonical";
import { closeDb, openDb } from "../../src/server/db";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_SPEAKER_PERSON_ID,
  EVALUATOR_WORKSPACE_ID,
} from "../../src/server/evaluator-demo";

interface BrowserFixture {
  readonly token: string;
  readonly emptyPersonId: string;
  readonly secondEventId: string;
}

function createBrowserFixture(): BrowserFixture {
  const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
  try {
    const organizer = db.prepare(`SELECT account.id AS accountId
      FROM accounts account JOIN workspaces workspace ON workspace.id = account.workspace_id
      WHERE workspace.slug = 'acme' AND account.role = 'organizer' ORDER BY account.id LIMIT 1`)
      .get() as { accountId: string } | undefined;
    if (!organizer) throw new Error("missing Acme organizer fixture");
    const emptyPersonId = deterministicUuid("returner-lens:e2e:empty-person");
    const secondEventId = deterministicUuid("returner-lens:e2e:second-event");
    const roleId = deterministicUuid("returner-lens:e2e:second-event-role");
    db.prepare(`INSERT OR IGNORE INTO people
        (id, workspace_id, canonical_email, full_name, organization, title, created_at)
      VALUES (?, ?, 'empty.returner@example.test', 'Empty Evidence Person',
        'Fixture-free Organization', 'No event history', '2026-08-13T10:00:00.000Z')`)
      .run(emptyPersonId, EVALUATOR_WORKSPACE_ID);
    db.prepare(`INSERT OR IGNORE INTO events
        (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
      VALUES (?, ?, 'Returner Forum 2027', 'UTC', '2027-02-10T09:00:00.000Z',
        '2027-02-10T17:00:00.000Z', 'planning', '2026-08-13T10:01:00.000Z')`)
      .run(secondEventId, EVALUATOR_WORKSPACE_ID);
    db.prepare(`INSERT OR IGNORE INTO event_speakers
        (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'MODERATOR', 'INVITED',
        '2026-08-13T10:02:00.000Z', '2026-08-13T10:02:00.000Z')`)
      .run(roleId, EVALUATOR_WORKSPACE_ID, secondEventId, EVALUATOR_SPEAKER_PERSON_ID);
    db.prepare("UPDATE events SET timezone = ? WHERE id = ?")
      .run("America/Los_Angeles", EVALUATOR_EVENT_ID);
    return {
      token: createSession(db, organizer.accountId, EVALUATOR_WORKSPACE_ID).token,
      emptyPersonId,
      secondEventId,
    };
  } finally {
    closeDb(db);
  }
}

async function useSession(context: BrowserContext, origin: string, token: string): Promise<void> {
  await context.addCookies([{ name: SESSION_COOKIE, value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const width = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
}

async function expectNoHighImpactAccessibilityViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""))).toEqual([]);
}

test("Returner Lens proves desktop, 390px, empty, multi-event, and workspace-denial states", async ({ page, context }) => {
  await page.goto("/");
  const fixture = createBrowserFixture();
  await useSession(context, new URL(page.url()).origin, fixture.token);

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/w/acme/memory");
  await expect(page.getByRole("heading", { name: "Mina Park", level: 2 })).toBeVisible();
  const eventLocalTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  }).format(new Date("2026-09-18T09:00:00.000Z"));
  await expect(page.getByText(eventLocalTime, { exact: true }).first()).toBeVisible();
  const taskDueLocalTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  }).format(new Date("2026-09-10T17:00:00.000Z"));
  await expect(page.getByText(taskDueLocalTime, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("America/Los_Angeles", { exact: false }).first()).toBeVisible();

  await page.goto(`/w/acme/memory?person=${fixture.emptyPersonId}`);
  await expect(page.getByRole("heading", { name: "Returner Lens", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Empty Evidence Person", level: 2 })).toBeVisible();
  await expect(page.getByText("No source-backed history is present for this person.")).toBeVisible();
  await expect(page.getByText("No event-linked evidence for this person")).toHaveCount(2);
  await expect(page.getByText("Attendee feedback")).toBeVisible();
  await expect(page.getByText("Speaker reliability")).toBeVisible();
  await expect(page.getByText("Nothing is carried forward")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoHighImpactAccessibilityViolations(page);
  expect((await page.screenshot()).byteLength).toBeGreaterThan(10_000);

  await page.goto(`/w/acme/memory?person=${EVALUATOR_SPEAKER_PERSON_ID}`);
  await expect(page.getByText("MULTI EVENT")).toBeVisible();
  const secondEvent = page.getByTestId("returner-lens").getByRole("article").filter({
    has: page.getByRole("link", { name: "Returner Forum 2027" }),
  });
  await expect(secondEvent).toBeVisible();
  const invitedRole = secondEvent.locator(`[data-family="session-role"]`).filter({ hasText: "Moderator relationship" });
  await expect(invitedRole).toBeVisible();
  await expect(invitedRole.getByText("Commitment", { exact: true })).toBeVisible();
  await expect(invitedRole.getByText("Operational", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Editorial approval", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Current authorization · NOT EVALUATED")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(page.getByLabel("Person")).toBeVisible();
  await expect(page.getByRole("button", { name: "View history" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoHighImpactAccessibilityViolations(page);
  expect((await page.screenshot({ fullPage: true })).byteLength).toBeGreaterThan(10_000);

  await page.goto("/w/northstar/memory");
  await expect(page.getByText("404")).toBeVisible();
  await expect(page.getByText("Empty Evidence Person")).toHaveCount(0);
});
