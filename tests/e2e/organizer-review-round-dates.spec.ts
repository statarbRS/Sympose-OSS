import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createSession, SESSION_COOKIE } from "../../src/server/auth";
import { closeDb, openDb } from "../../src/server/db";
import {
  createOrganizerReviewRound,
  createOrganizerReviewRubric,
} from "../../src/server/services/cfp-review/organizer";
import {
  createCall,
  createFormDefinition,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";

type RoundProof = Readonly<{
  name: string;
  opensAt: string;
  closesAt: string;
  scheduleVersion: number;
  scorecardLabel: string;
}>;

function createRoundDateFixture(): {
  readonly eventId: string;
  readonly organizerToken: string;
  readonly rounds: readonly RoundProof[];
} {
  const db = openDb({ path: resolve(".tmp/e2e/sympose.db") });
  try {
    const workspace = db.prepare(
      "SELECT id FROM workspaces WHERE slug = 'northstar'",
    ).get() as { id: string };
    const organizer = db.prepare(
      "SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' ORDER BY id LIMIT 1",
    ).get(workspace.id) as { id: string };
    const organizerSession = createSession(db, organizer.id, workspace.id);
    const eventId = randomUUID();
    db.prepare(
      `INSERT INTO events
         (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES (?, ?, 'Round date browser proof', 'UTC', ?, ?, 'planning', ?)`,
    ).run(
      eventId,
      workspace.id,
      "2026-09-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
    );
    const context = { workspaceId: workspace.id, accountId: organizer.id };
    const definition = createFormDefinition(db, context, { name: "Round date browser form" });
    const form = sealFormVersion(db, context, {
      formDefinitionId: definition.id,
      fields: [{
        id: "proposal",
        type: "longText",
        label: "Proposal",
        required: true,
        defaultVisibility: "visible",
      }],
      rules: { schema: FORM_RULES_SCHEMA, rules: [] },
    });
    const call = createCall(db, context, {
      eventId,
      name: "Round date browser call",
      slug: `round-date-browser-${eventId}`,
      formVersionId: form.id,
      state: "OPEN",
      timezone: "UTC",
      opensAt: "2026-09-02T00:00:00.000Z",
      closesAt: "2026-09-25T00:00:00.000Z",
      policy: {
        disclosure: {
          privacy: "synthetic",
          retention: "synthetic",
          aiProcessing: "synthetic",
          communication: "synthetic",
          consent: "synthetic",
          publication: "synthetic",
        },
        choices: [],
      },
    });
    const rounds: readonly RoundProof[] = [
      {
        name: "Editorial screening",
        opensAt: "2026-09-03T09:00:00.000Z",
        closesAt: "2026-09-10T17:00:00.000Z",
        scheduleVersion: 2,
        scorecardLabel: "Editorial strength",
      },
      {
        name: "Program committee",
        opensAt: "2026-09-12T10:00:00.000Z",
        closesAt: "2026-09-22T18:00:00.000Z",
        scheduleVersion: 2,
        scorecardLabel: "Program fit",
      },
    ];
    for (const roundProof of rounds) {
      const round = createOrganizerReviewRound(db, organizerSession.session, {
        workspaceSlug: "northstar",
        eventId,
        callId: call.id,
        name: roundProof.name,
        opensAt: roundProof.opensAt,
        closesAt: roundProof.closesAt,
        idempotencyKey: `round-date-browser:${roundProof.name.toLowerCase().replaceAll(" ", "-")}`,
      });
      createOrganizerReviewRubric(db, organizerSession.session, {
        workspaceSlug: "northstar",
        roundId: round.roundId,
        fields: [{
          id: roundProof.scorecardLabel.toLowerCase().replaceAll(" ", "-"),
          label: roundProof.scorecardLabel,
          kind: "numeric",
          required: true,
          weight: 1,
          minimum: 0,
          maximum: 5,
          step: 1,
        }],
      });
    }
    return { eventId, organizerToken: organizerSession.token, rounds };
  } finally {
    closeDb(db);
  }
}

async function useOrganizerSession(
  context: BrowserContext,
  page: Page,
  token: string,
): Promise<void> {
  await page.goto("/");
  await context.addCookies([{
    name: SESSION_COOKIE,
    value: token,
    url: new URL(page.url()).origin,
    httpOnly: true,
    sameSite: "Lax",
  }]);
}

async function expectPersistedRounds(page: Page, rounds: readonly RoundProof[]): Promise<void> {
  for (const expectedRound of rounds) {
    const card = page.getByTestId("organizer-review-round").filter({ hasText: expectedRound.name });
    const setup = page.getByTestId("organizer-review-round-setup").filter({ hasText: `${expectedRound.name} setup` });
    await expect(card.getByRole("heading", { name: expectedRound.name, level: 2 })).toBeVisible();
    await expect(setup.getByLabel("Opens (UTC)")).toHaveValue(expectedRound.opensAt.slice(0, 16));
    await expect(setup.getByLabel("Closes (UTC)")).toHaveValue(expectedRound.closesAt.slice(0, 16));
    await expect(setup.getByText(`Saved v${expectedRound.scheduleVersion}`, { exact: true })).toBeVisible();
    await expect(setup.getByText("persisted UTC timezone", { exact: false })).toBeVisible();
    await expect(setup.getByText(expectedRound.scorecardLabel, { exact: true })).toBeVisible();
  }
}

async function openSetup(page: Page): Promise<void> {
  const setupDisclosure = page.getByTestId("review-secondary-setup").locator("details").first();
  const isOpen = await setupDisclosure.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!isOpen) {
    await setupDisclosure.locator("summary").first().click();
  }
  await expect(setupDisclosure).toHaveAttribute("open", "");
}

test("two independent organizer round dates and scorecards survive reload", async ({
  context,
  page,
}) => {
  const fixture = createRoundDateFixture();
  await useOrganizerSession(context, page, fixture.organizerToken);
  await page.goto(`/w/northstar/events/${fixture.eventId}/review`);
  await expect(page.getByTestId("organizer-review-round")).toHaveCount(2);
  const createForm = page.getByTestId("review-round-form");
  await expect(createForm.getByLabel("Round opens (UTC)")).toHaveValue("2026-09-02T00:00");
  await expect(createForm.getByLabel("Round closes (UTC)")).toHaveValue("2026-09-25T00:00");
  await expect(createForm.getByLabel("Available CFP call")).toContainText("UTC");
  await openSetup(page);
  await expectPersistedRounds(page, fixture.rounds);

  await page.reload();
  await expect(page.getByTestId("organizer-review-round")).toHaveCount(2);
  await openSetup(page);
  await expectPersistedRounds(page, fixture.rounds);

  const editorialSetup = page
    .getByTestId("organizer-review-round-setup")
    .filter({ hasText: "Editorial screening setup" });
  await editorialSetup.getByLabel("Opens (UTC)").fill("2026-09-04T08:30");
  await editorialSetup.getByLabel("Closes (UTC)").fill("2026-09-11T19:30");
  await editorialSetup.getByRole("button", { name: "Save review window" }).click();
  await expect(editorialSetup.getByText("Review-round schedule v3 was saved.", { exact: false })).toBeVisible();

  const updatedRounds: readonly RoundProof[] = [
    {
      ...fixture.rounds[0]!,
      opensAt: "2026-09-04T08:30:00.000Z",
      closesAt: "2026-09-11T19:30:00.000Z",
      scheduleVersion: 3,
    },
    fixture.rounds[1]!,
  ];
  await expectPersistedRounds(page, updatedRounds);

  await page.reload();
  await expect(page.getByTestId("organizer-review-round")).toHaveCount(2);
  await openSetup(page);
  await expectPersistedRounds(page, updatedRounds);
});
