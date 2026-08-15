import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { EventSwitcher } from "@/app/w/[workspace]/events/_components/event-switcher";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  createEventWithUnit,
  listEvents,
  MAX_EVENTS_PER_WORKSPACE,
} from "@/server/services/events";

const temporaryPaths: string[] = [];

function openPersistentFixture(): { db: Db; workspaceId: string; actor: { kind: "account"; ref: string }; path: string } {
  const path = mkdtempSync(join(tmpdir(), "sympose-second-event-"));
  temporaryPaths.push(path);
  const db = openDb({ path: join(path, "sympose.db") });
  const workspace = db
    .prepare("SELECT id FROM workspaces WHERE slug = 'northstar'")
    .get() as { id: string };
  const account = db
    .prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY created_at LIMIT 1")
    .get(workspace.id) as { id: string };
  return { db, workspaceId: workspace.id, actor: { kind: "account", ref: account.id }, path };
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("bounded second-event portfolio command", () => {
  it("persists one independent second event, replays it idempotently, and refuses a third", () => {
    const fixture = openPersistentFixture();
    const first = createEventWithUnit(fixture.db, fixture.workspaceId, fixture.actor, {
      eventName: "First Event",
      unitName: "First Opening",
      capacity: 6,
    });
    const second = createEventWithUnit(fixture.db, fixture.workspaceId, fixture.actor, {
      eventName: "Second Event",
      unitName: "Second Opening",
      capacity: 8,
    });

    expect(MAX_EVENTS_PER_WORKSPACE).toBe(2);
    expect(second).toMatchObject({ eventCreated: true, programUnitCreated: true });
    expect(second.eventId).not.toBe(first.eventId);
    expect(
      (fixture.db.prepare("SELECT COUNT(*) AS count FROM events WHERE workspace_id = ?").get(fixture.workspaceId) as { count: number }).count,
    ).toBe(2);
    expect(
      fixture.db
        .prepare("SELECT name FROM program_units WHERE workspace_id = ? AND event_id = ?")
        .all(fixture.workspaceId, second.eventId),
    ).toEqual([{ name: "Second Opening" }]);

    closeDb(fixture.db);
    const reopened = openDb({ path: join(fixture.path, "sympose.db") });
    try {
      expect(listEvents(reopened, fixture.workspaceId).map((event) => event.name).sort()).toEqual([
        "First Event",
        "Second Event",
      ]);

      const replay = createEventWithUnit(reopened, fixture.workspaceId, fixture.actor, {
        eventName: "Second Event",
        unitName: "Second Opening",
        capacity: 8,
      });
      expect(replay).toEqual({
        eventId: second.eventId,
        programUnitId: second.programUnitId,
        eventCreated: false,
        programUnitCreated: false,
      });
      expect(() =>
        createEventWithUnit(reopened, fixture.workspaceId, fixture.actor, {
          eventName: "Third Event",
          unitName: "Third Opening",
          capacity: 6,
        }),
      ).toThrow(/EVENT_CARDINALITY_INVALID/);
      expect(listEvents(reopened, fixture.workspaceId)).toHaveLength(2);
    } finally {
      closeDb(reopened);
    }
  });

  it("shows the created event in the workspace switcher after the return redirect", () => {
    const html = renderToStaticMarkup(
      createElement(EventSwitcher, {
        workspace: "northstar",
        createdEventId: "event-two",
        events: [
          {
            id: "event-one",
            name: "First Event",
            timezone: "UTC",
            startsAt: "2026-09-15T09:00:00.000Z",
            endsAt: "2026-09-15T13:00:00.000Z",
            lifecycle: "planning",
            currentPlanVersionId: null,
            currentReleaseId: null,
            createdAt: "2026-08-10T00:00:00.000Z",
          },
          {
            id: "event-two",
            name: "Second Event",
            timezone: "UTC",
            startsAt: "2026-10-15T09:00:00.000Z",
            endsAt: "2026-10-15T13:00:00.000Z",
            lifecycle: "planning",
            currentPlanVersionId: null,
            currentReleaseId: null,
            createdAt: "2026-08-11T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(html).toContain('data-testid="event-created-status"');
    expect(html).toContain("Second Event");
    expect(html).toContain('href="/w/northstar/events/event-two/overview"');
    expect(html).toContain("This bounded MVP allows 2 events per workspace");
  });
});
