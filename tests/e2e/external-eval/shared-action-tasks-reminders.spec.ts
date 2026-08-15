import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { createSession, SESSION_COOKIE } from "../../../src/server/auth";
import { canonicalJson, fingerprintOf } from "../../../src/server/canonical";
import { closeDb, openDb } from "../../../src/server/db";
import { readAcceptedCurrentPlanAssignmentId } from "../../../src/server/services/evaluator-speaker-identity";
import { issueSpeakerPortalToken } from "../../../src/server/services/speaker-portal-access";

const ORIGIN = "http://127.0.0.1:3100";
const WORKSPACE_SLUG = "shared-action-e2e";

interface BrowserFixture {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly organizerToken: string;
  readonly dueDate: string;
  readonly laterDueDates: readonly [string, string];
  readonly speakers: readonly [
    { readonly personId: string; readonly name: string; readonly email: string; readonly portalToken: string },
    { readonly personId: string; readonly name: string; readonly email: string; readonly portalToken: string },
  ];
}

function createBrowserFixture(): BrowserFixture {
  const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
  try {
    const suffix = randomUUID().slice(0, 8);
    const workspaceId = `shared-action-workspace-${suffix}`;
    const organizerId = `shared-action-organizer-${suffix}`;
    const eventId = `shared-action-event-${suffix}`;
    const unitId = `shared-action-unit-${suffix}`;
    const runId = `shared-action-run-${suffix}`;
    const planId = `shared-action-plan-${suffix}`;
    const createdAt = new Date().toISOString();
    const day = Date.parse(`${createdAt.slice(0, 10)}T00:00:00.000Z`);
    const startsAt = new Date(day + 30 * 24 * 60 * 60 * 1_000 + 9 * 60 * 60 * 1_000).toISOString();
    const endsAt = new Date(Date.parse(startsAt) + 8 * 60 * 60 * 1_000).toISOString();
    const dueDate = new Date(day + 2 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
    const laterDueDates = [10, 20].map((offset) => new Date(day + offset * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10)) as unknown as readonly [string, string];

    db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
      .run(workspaceId, WORKSPACE_SLUG, "Shared ACTION Browser Workspace", createdAt);
    db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, 'organizer', ?)")
      .run(organizerId, workspaceId, `organizer-${suffix}@example.test`, "Shared ACTION Organizer", createdAt);
    db.prepare(
      `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
    ).run(eventId, workspaceId, "Shared ACTION Browser Forum", startsAt, endsAt, createdAt);
    db.prepare(
      `INSERT INTO program_units
         (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
       VALUES (?, ?, ?, ?, 'SESSION', ?, ?, 10, ?)`,
    ).run(unitId, workspaceId, eventId, "Browser Evidence Session", startsAt, new Date(Date.parse(startsAt) + 60 * 60 * 1_000).toISOString(), createdAt);
    db.prepare(
      `INSERT INTO plan_runs
         (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json, compiler, compiler_version, created_at)
       VALUES (?, ?, ?, 'completed', ?, ?, 'browser-fixture', '1', ?)`,
    ).run(runId, workspaceId, eventId, fingerprintOf({ eventId, fixture: "shared-action" }), canonicalJson({ fixture: "shared-action" }), createdAt);
    const planFingerprint = fingerprintOf({ workspaceId, eventId, planId, speakers: 2 });
    db.prepare(
      `INSERT INTO plan_versions
         (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(planId, workspaceId, eventId, runId, planFingerprint, canonicalJson({ schema: "shared-action-browser-plan/v1", eventId }), createdAt);
    db.prepare("UPDATE events SET current_plan_version_id = ? WHERE workspace_id = ? AND id = ?")
      .run(planId, workspaceId, eventId);
    db.prepare(
      "INSERT INTO plan_states (id, workspace_id, plan_version_id, state, actor_account_id, created_at) VALUES (?, ?, ?, 'approved', ?, ?)",
    ).run(`shared-action-plan-state-${suffix}`, workspaceId, planId, organizerId, createdAt);
    db.prepare(
      "INSERT INTO approvals (id, workspace_id, event_id, plan_version_id, actor_account_id, decision, created_at) VALUES (?, ?, ?, ?, ?, 'approved', ?)",
    ).run(`shared-action-approval-${suffix}`, workspaceId, eventId, planId, organizerId, createdAt);
    const { token: organizerToken, session: organizerSession } = createSession(db, organizerId, workspaceId);

    const speakerSeeds = [
      { personId: `shared-action-person-a-${suffix}`, name: "Avery Stone", email: `avery-${suffix}@example.test` },
      { personId: `shared-action-person-b-${suffix}`, name: "Blair Rowan", email: `blair-${suffix}@example.test` },
    ] as const;
    const issuedSpeakers = speakerSeeds.map((speaker, index) => {
      const assignmentId = `shared-action-assignment-${index}-${suffix}`;
      const offerId = `shared-action-offer-${index}-${suffix}`;
      db.prepare(
        "INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(speaker.personId, workspaceId, speaker.email, speaker.name, "Browser Evidence Lab", "Speaker", createdAt);
      db.prepare(
        `INSERT INTO plan_assignments
           (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation)
         VALUES (?, ?, ?, ?, ?, 'SPEAKER', ?)`,
      ).run(assignmentId, workspaceId, planId, speaker.personId, unitId, "Shared ACTION browser authority");
      const terms = {
        schema: "commitment-offer-terms/v1",
        planVersionId: planId,
        planFingerprint,
        eventId,
        eventName: "Shared ACTION Browser Forum",
        timezone: "UTC",
        programUnitId: unitId,
        programUnitName: "Browser Evidence Session",
        role: "SPEAKER",
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + 60 * 60 * 1_000).toISOString(),
      };
      db.prepare(
        `INSERT INTO commitment_offers
           (id, workspace_id, event_id, plan_version_id, person_id, terms_json, terms_fingerprint, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', ?)`,
      ).run(offerId, workspaceId, eventId, planId, speaker.personId, canonicalJson(terms), fingerprintOf(terms), createdAt);
      db.prepare(
        `INSERT INTO commitment_responses
           (id, workspace_id, offer_id, response, responded_at, actor_person_id)
         VALUES (?, ?, ?, 'accepted', ?, ?)`,
      ).run(`shared-action-response-${index}-${suffix}`, workspaceId, offerId, createdAt, speaker.personId);
      db.prepare(
        `INSERT INTO event_speakers
           (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'SPEAKER', 'CONFIRMED', ?, ?)`,
      ).run(`shared-action-event-speaker-${index}-${suffix}`, workspaceId, eventId, speaker.personId, createdAt, createdAt);
      expect(readAcceptedCurrentPlanAssignmentId(db, { workspaceId, eventId, personId: speaker.personId })).toBe(assignmentId);
      return {
        ...speaker,
        portalToken: issueSpeakerPortalToken(db, {
          workspaceId,
          eventId,
          personId: speaker.personId,
        }, {
          accountId: organizerSession.accountId,
          sessionId: organizerSession.id,
        }).token,
      };
    }) as unknown as BrowserFixture["speakers"];
    return {
      workspaceId,
      eventId,
      organizerToken,
      dueDate,
      laterDueDates,
      speakers: issuedSpeakers,
    };
  } finally {
    closeDb(db);
  }
}

async function organizerPage(page: Page, fixture: BrowserFixture): Promise<void> {
  await page.context().addCookies([{
    name: SESSION_COOKIE,
    value: fixture.organizerToken,
    url: ORIGIN,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await page.goto(`/w/${WORKSPACE_SLUG}/events/${fixture.eventId}/speakers`);
  await expect(page.getByRole("heading", { name: "Speaker commitments and operations", level: 1 })).toBeVisible();
}

async function scopedSpeakerPage(browser: Browser, token: string): Promise<{ readonly context: BrowserContext; readonly page: Page }> {
  const context = await browser.newContext();
  await context.addCookies([{
    name: "sympose_speaker_portal",
    value: token,
    url: ORIGIN,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  const page = await context.newPage();
  await page.goto("/speaker");
  await expect(page.getByRole("heading", { name: /^Welcome, /u, level: 1 })).toBeVisible();
  return { context, page };
}

test.describe("shared ACTION task and reminder browser evidence", () => {
  test.setTimeout(90_000);

  test("assigns two speakers, preserves portal isolation/completion, and exposes PENDING reminder receipts", async ({ browser, page }) => {
    const fixture = createBrowserFixture();
    await organizerPage(page, fixture);
    const panel = page.getByTestId("shared-action-tasks-panel");
    await expect(panel).toContainText("2 selected · 2 current");
    const assignees = panel.locator('input[name="personId"]');
    await expect(assignees).toHaveCount(2);
    await expect(assignees.nth(0)).toBeChecked();
    await expect(assignees.nth(1)).toBeChecked();
    const createTask = async (title: string, instructions: string, dueDate: string): Promise<void> => {
      await panel.getByLabel("Title", { exact: true }).fill(title);
      await panel.getByLabel("Instructions", { exact: true }).fill(instructions);
      await panel.getByLabel("Due date (UTC)", { exact: true }).fill(dueDate);
      await panel.getByRole("button", { name: "Create for 2 speakers", exact: true }).click();
      await expect(panel.getByTestId("shared-action-task-success")).toContainText("Created one ACTION task for 2 speakers atomically.");
      await expect(panel.getByTestId("shared-action-task-history")).toContainText(title);
    };
    await createTask(
      "Confirm browser logistics",
      "Confirm your arrival window and accessibility needs.",
      fixture.dueDate,
    );
    await createTask(
      "Review speaker biography",
      "Review the biography shown in the speaker brief.",
      fixture.laterDueDates[0],
    );
    await createTask(
      "Acknowledge venue guide",
      "Read the venue guide and retain it for event day.",
      fixture.laterDueDates[1],
    );
    const taskHistory = panel.getByTestId("shared-action-task-history");
    await expect(taskHistory.locator("caption")).toHaveCount(3);
    await expect(taskHistory.locator("tbody tr")).toHaveCount(6);
    await expect(taskHistory.getByText("0/2 complete", { exact: false })).toHaveCount(3);
    for (const speaker of fixture.speakers) await expect(taskHistory).toContainText(speaker.name);

    await panel.getByRole("button", { name: "Queue due reminders", exact: true }).click();
    await expect(panel.getByTestId("action-task-reminder-success")).toContainText("Queued 2 PENDING reminders; skipped 4. No provider was contacted.");
    await expect(panel.getByTestId("action-task-reminder-success")).toContainText("not due 4");
    const reminderHistory = panel.getByTestId("action-task-reminder-history");
    await expect(reminderHistory.getByText("PENDING", { exact: true })).toHaveCount(2);
    for (const speaker of fixture.speakers) {
      await expect(reminderHistory).toContainText(speaker.name);
      await expect(reminderHistory).toContainText(speaker.email);
    }
    await expect(reminderHistory).toContainText("provider mutation false");
    await expect(reminderHistory).toContainText("Local queue only · no provider contacted");

    await panel.getByRole("button", { name: "Queue due reminders", exact: true }).click();
    await expect(panel.getByTestId("action-task-reminder-success")).toContainText("Queued 0 PENDING reminders; skipped 6. No provider was contacted.");
    await expect(reminderHistory.getByText("PENDING", { exact: true })).toHaveCount(2);

    const portalA = await scopedSpeakerPage(browser, fixture.speakers[0].portalToken);
    const portalB = await scopedSpeakerPage(browser, fixture.speakers[1].portalToken);
    try {
      await expect(portalA.page.getByRole("heading", { name: `Welcome, ${fixture.speakers[0].name}`, level: 1 })).toBeVisible();
      await expect(portalB.page.getByRole("heading", { name: `Welcome, ${fixture.speakers[1].name}`, level: 1 })).toBeVisible();
      await expect(portalA.page.getByText(fixture.speakers[1].name, { exact: true })).toHaveCount(0);
      await expect(portalB.page.getByText(fixture.speakers[0].name, { exact: true })).toHaveCount(0);
      const portalATasks = portalA.page.locator('section[aria-labelledby="tasks-title"]');
      const portalBTasks = portalB.page.locator('section[aria-labelledby="tasks-title"]');
      for (const title of ["Confirm browser logistics", "Review speaker biography", "Acknowledge venue guide"]) {
        await expect(portalATasks.getByRole("heading", { name: title, exact: true, level: 3 })).toHaveCount(1);
        await expect(portalBTasks.getByRole("heading", { name: title, exact: true, level: 3 })).toHaveCount(1);
      }
      const taskA = portalA.page.locator("article").filter({ hasText: "Confirm browser logistics" }).first();
      const taskB = portalB.page.locator("article").filter({ hasText: "Confirm browser logistics" }).first();
      await expect(taskA).toContainText("Confirm your arrival window and accessibility needs.");
      await expect(taskB).toContainText("Confirm your arrival window and accessibility needs.");
      const taskIdA = await taskA.locator('input[name="taskId"]').getAttribute("value");
      const taskIdB = await taskB.locator('input[name="taskId"]').getAttribute("value");
      expect(taskIdA).toBeTruthy();
      expect(taskIdB).toBeTruthy();
      expect(taskIdA).not.toBe(taskIdB);
      await expect(portalA.page.locator(`input[name="taskId"][value="${taskIdB}"]`)).toHaveCount(0);
      await expect(portalB.page.locator(`input[name="taskId"][value="${taskIdA}"]`)).toHaveCount(0);
      await taskA.getByLabel("Completion note", { exact: true }).fill("Browser completion evidence");
      await taskA.getByRole("button", { name: "Mark complete", exact: true }).click();
      await expect(taskA).toContainText("COMPLETED");
    } finally {
      await portalA.context.close();
      await portalB.context.close();
    }

    await page.reload();
    const refreshedPanel = page.getByTestId("shared-action-tasks-panel");
    const refreshedHistory = refreshedPanel.getByTestId("shared-action-task-history");
    const completedTaskTable = refreshedHistory.locator("table").filter({ hasText: "Confirm browser logistics" });
    await expect(completedTaskTable).toContainText("1/2 complete");
    await expect(refreshedHistory.locator("caption")).toHaveCount(3);
    const completedRow = completedTaskTable.locator("tbody tr").filter({ hasText: fixture.speakers[0].name });
    const pendingRow = completedTaskTable.locator("tbody tr").filter({ hasText: fixture.speakers[1].name });
    await expect(completedRow).toContainText("COMPLETED");
    await expect(pendingRow).toContainText("NOT_STARTED");
    await expect(refreshedPanel.getByTestId("action-task-reminder-history").getByText("PENDING", { exact: true })).toHaveCount(2);

    const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
    try {
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM outbox_messages outbox
         JOIN domain_events event_row ON event_row.id = outbox.domain_event_id
         WHERE event_row.workspace_id = ? AND event_row.event_type = 'speaker.action-task.reminder.queued'
           AND json_extract(event_row.payload_json, '$.eventId') = ? AND outbox.status = 'PENDING'`,
      ).get(fixture.workspaceId, fixture.eventId)).toEqual({ count: 2 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM domain_events
         WHERE workspace_id = ? AND event_type = 'speaker.action-task.batch.created'
           AND json_extract(payload_json, '$.eventId') = ?`,
      ).get(fixture.workspaceId, fixture.eventId)).toEqual({ count: 3 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM domain_events
         WHERE workspace_id = ? AND event_type = 'speaker.task.created'
           AND json_extract(payload_json, '$.eventId') = ?
           AND json_extract(payload_json, '$.task.kind') = 'ACTION'`,
      ).get(fixture.workspaceId, fixture.eventId)).toEqual({ count: 6 });
      const payloads = db.prepare(
        `SELECT outbox.payload_json AS payloadJson FROM outbox_messages outbox
         JOIN domain_events event_row ON event_row.id = outbox.domain_event_id
         WHERE event_row.workspace_id = ? AND event_row.event_type = 'speaker.action-task.reminder.queued'
           AND json_extract(event_row.payload_json, '$.eventId') = ?`,
      ).all(fixture.workspaceId, fixture.eventId) as Array<{ readonly payloadJson: string }>;
      expect(payloads).toHaveLength(2);
      for (const row of payloads) expect(JSON.parse(row.payloadJson)).toMatchObject({ channel: "local", providerMutation: false });
    } finally {
      closeDb(db);
    }
  });
});
