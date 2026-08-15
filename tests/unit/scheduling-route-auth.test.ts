import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  cookieValue: undefined as string | undefined,
  revalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name === "sympose_session" && mocks.cookieValue ? { value: mocks.cookieValue } : undefined,
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/server/db")>("@/server/db");
  return { ...actual, getDb: vi.fn(() => mocks.db) };
});

import { createSession } from "../../src/server/auth";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_PROGRAM_UNIT_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
} from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import {
  approveScheduleDraftAction,
  saveScheduleDraftAction,
} from "../../src/app/w/[workspace]/events/[eventId]/program/actions";
import { readScheduleDraft } from "../../src/server/services/scheduling/persistence";
import { readCurrentScheduleApproval } from "../../src/server/services/scheduling/approval";
import type { ScheduleSnapshot } from "../../src/server/services/scheduling/types";

const CREATED_AT = "2026-08-12T10:00:00.000Z";

function seedFixture(): {
  db: Db;
  organizerToken: string;
  readOnlyToken: string;
  workspaceA: string;
  eventA: string;
  eventB: string;
} {
  const db = openDb({ path: ":memory:", seed: false });
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  const workspaceA = EVALUATOR_WORKSPACE_ID;
  const workspaceB = "workspace-route-auth-foreign";
  const eventA = EVALUATOR_EVENT_ID;
  const eventB = "event-route-auth-foreign";
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(workspaceB, "bravo", "Bravo", CREATED_AT);
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, 'UTC', '2026-09-15T09:00:00.000Z', '2026-09-16T15:00:00.000Z', 'planning', ?)`,
  ).run(eventB, workspaceB, "Bravo event", CREATED_AT);
  db.prepare(
    `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
     VALUES ('account-route-auth-read-only', ?, 'read-only@example.test', 'Read Only', 'read_only', ?)`,
  ).run(workspaceA, CREATED_AT);
  const organizerToken = createSession(db, EVALUATOR_ORGANIZER_ACCOUNT_ID, workspaceA).token;
  const readOnlyToken = createSession(db, "account-route-auth-read-only", workspaceA).token;
  return { db, organizerToken, readOnlyToken, workspaceA, eventA, eventB };
}

function formFor(
  eventId: string,
  expectedRevision: number,
  command: unknown,
  schedule: ScheduleSnapshot,
  idempotencyKey = `key-${eventId}-${expectedRevision}`,
  requestId = `request-${eventId}-${expectedRevision}`,
): FormData {
  const form = new FormData();
  form.set("eventId", eventId);
  form.set("expectedRevision", String(expectedRevision));
  form.set("planVersionId", schedule.planVersionId);
  form.set("planFingerprint", schedule.planFingerprint);
  form.set("acceptedInventoryFingerprint", schedule.acceptedInventoryFingerprint);
  form.set("cfpSessionInventoryFingerprint", schedule.cfpSessionInventoryFingerprint);
  form.set("command", JSON.stringify(command));
  form.set("idempotencyKey", idempotencyKey);
  form.set("requestId", requestId);
  form.set("activeDayId", schedule.days[0]!.id);
  return form;
}

function moveCommandFor(schedule: ScheduleSnapshot) {
  const target = schedule.timeSlots.find((slot) => slot.startsAt === "2026-09-18T09:00:00.000Z");
  if (!target) throw new Error("route-auth canonical target slot is unavailable");
  return {
    kind: "MOVE" as const,
    sessionId: EVALUATOR_PROGRAM_UNIT_ID,
    target: {
      dayId: target.dayId,
      timeSlotId: target.id,
      roomId: schedule.rooms[0]!.id,
      trackId: schedule.tracks[0]!.id,
    },
  };
}

function scheduleEventCount(db: Db): number {
  return (db.prepare(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'organizer.schedule_draft.saved'",
  ).get() as { count: number }).count;
}

function approvalEventCount(db: Db): number {
  return (db.prepare(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'organizer.schedule.approved'",
  ).get() as { count: number }).count;
}

function approvalFormFor(
  eventId: string,
  expectedRevision: number,
  expectedScheduleAuthorityFingerprint: string,
  suffix: string,
): FormData {
  const form = new FormData();
  form.set("eventId", eventId);
  form.set("expectedRevision", String(expectedRevision));
  form.set("expectedScheduleAuthorityFingerprint", expectedScheduleAuthorityFingerprint);
  form.set("idempotencyKey", `approval-${suffix}`);
  form.set("requestId", `approval-request-${suffix}`);
  return form;
}

describe("organizer schedule draft action authorization and validation", () => {
  beforeEach(() => {
    mocks.db = null;
    mocks.cookieValue = undefined;
    mocks.revalidatePath.mockClear();
  });

  it("rejects an unauthenticated command before any event lookup or write", async () => {
    const fixture = seedFixture();
    mocks.db = fixture.db;
    try {
      const before = scheduleEventCount(fixture.db);
      const schedule = readScheduleDraft(fixture.db, { workspaceId: fixture.workspaceA, eventId: fixture.eventA }).schedule;
      const result = await saveScheduleDraftAction(formFor(fixture.eventA, schedule.revision, moveCommandFor(schedule), schedule));
      expect(result).toMatchObject({ ok: false, code: "SESSION_REQUIRED" });
      expect(scheduleEventCount(fixture.db)).toBe(before);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rejects a non-organizer and a foreign event without disclosure or draft writes", async () => {
    const fixture = seedFixture();
    mocks.db = fixture.db;
    try {
      const before = scheduleEventCount(fixture.db);
      const schedule = readScheduleDraft(fixture.db, { workspaceId: fixture.workspaceA, eventId: fixture.eventA }).schedule;
      const moveCommand = moveCommandFor(schedule);
      mocks.cookieValue = fixture.readOnlyToken;
      const denied = await saveScheduleDraftAction(formFor(fixture.eventA, schedule.revision, moveCommand, schedule));
      expect(denied).toMatchObject({ ok: false, code: "CAPABILITY_DENIED" });

      mocks.cookieValue = fixture.organizerToken;
      const foreign = await saveScheduleDraftAction(formFor(fixture.eventB, schedule.revision, moveCommand, schedule));
      expect(foreign).toMatchObject({ ok: false, code: "SCHEDULE_SCOPE_DENIED" });
      if (!foreign.ok) expect(foreign.message).not.toContain("workspace-b");
      expect(scheduleEventCount(fixture.db)).toBe(before);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("rejects malformed and oversized command bodies generically", async () => {
    const fixture = seedFixture();
    mocks.db = fixture.db;
    mocks.cookieValue = fixture.organizerToken;
    try {
      const before = scheduleEventCount(fixture.db);
      const schedule = readScheduleDraft(fixture.db, { workspaceId: fixture.workspaceA, eventId: fixture.eventA }).schedule;
      const malformed = new FormData();
      malformed.set("eventId", fixture.eventA);
      malformed.set("expectedRevision", "1");
      malformed.set("command", "{");
      expect(await saveScheduleDraftAction(malformed)).toMatchObject({ ok: false, code: "SCHEDULE_INPUT_INVALID" });

      const oversized = formFor(fixture.eventA, schedule.revision, "x".repeat(100_001), schedule);
      expect(await saveScheduleDraftAction(oversized)).toMatchObject({ ok: false, code: "SCHEDULE_INPUT_INVALID" });
      expect(scheduleEventCount(fixture.db)).toBe(before);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("returns the authoritative pointer for a stale action and does not overwrite it", async () => {
    const fixture = seedFixture();
    mocks.db = fixture.db;
    mocks.cookieValue = fixture.organizerToken;
    try {
      const before = scheduleEventCount(fixture.db);
      const schedule = readScheduleDraft(fixture.db, { workspaceId: fixture.workspaceA, eventId: fixture.eventA }).schedule;
      const moveCommand = moveCommandFor(schedule);
      const first = await saveScheduleDraftAction(formFor(fixture.eventA, schedule.revision, moveCommand, schedule));
      expect(first).toMatchObject({ ok: true, code: "SCHEDULE_DRAFT_SAVED" });

      const stale = await saveScheduleDraftAction(formFor(
        fixture.eventA,
        schedule.revision,
        moveCommand,
        schedule,
        "stale-key",
        "stale-request",
      ));
      expect(stale).toMatchObject({ ok: false, code: "SCHEDULE_REVISION_CONFLICT" });
      if (!stale.ok) {
        expect(stale.message).toContain("server");
        expect(stale.pointer?.revision).toBe(2);
      }
      expect(scheduleEventCount(fixture.db)).toBe(before + 1);
    } finally {
      closeDb(fixture.db);
    }
  });
});

describe("organizer schedule approval action authorization and replay", () => {
  beforeEach(() => {
    mocks.db = null;
    mocks.cookieValue = undefined;
    mocks.revalidatePath.mockClear();
  });

  it("rejects unauthenticated, read-only, foreign, and malformed approval attempts without writes", async () => {
    const fixture = seedFixture();
    mocks.db = fixture.db;
    try {
      const schedule = readScheduleDraft(fixture.db, {
        workspaceId: fixture.workspaceA,
        eventId: fixture.eventA,
      }).schedule;
      const fingerprint = readCurrentScheduleApproval(fixture.db, {
        workspaceId: fixture.workspaceA,
        eventId: fixture.eventA,
      })!.scheduleAuthorityFingerprint;
      const before = approvalEventCount(fixture.db);

      expect(await approveScheduleDraftAction(approvalFormFor(fixture.eventA, schedule.revision, fingerprint, "anonymous")))
        .toMatchObject({ ok: false, code: "SESSION_REQUIRED" });

      mocks.cookieValue = fixture.readOnlyToken;
      expect(await approveScheduleDraftAction(approvalFormFor(fixture.eventA, schedule.revision, fingerprint, "read-only")))
        .toMatchObject({ ok: false, code: "CAPABILITY_DENIED" });

      mocks.cookieValue = fixture.organizerToken;
      const foreign = await approveScheduleDraftAction(approvalFormFor(fixture.eventB, schedule.revision, fingerprint, "foreign"));
      expect(foreign).toMatchObject({ ok: false, code: "SCHEDULE_APPROVAL_SCOPE_DENIED" });
      if (!foreign.ok) expect(foreign.message).not.toContain(fixture.workspaceA);

      const malformed = approvalFormFor(fixture.eventA, schedule.revision, fingerprint, "malformed");
      malformed.set("idempotencyKey", "invalid key with spaces");
      expect(await approveScheduleDraftAction(malformed))
        .toMatchObject({ ok: false, code: "SCHEDULE_APPROVAL_INPUT_INVALID" });
      expect(approvalEventCount(fixture.db)).toBe(before);
    } finally {
      closeDb(fixture.db);
    }
  });

  it("records one exact approval and returns the original immutable receipt on replay", async () => {
    const fixture = seedFixture();
    mocks.db = fixture.db;
    mocks.cookieValue = fixture.organizerToken;
    try {
      const schedule = readScheduleDraft(fixture.db, {
        workspaceId: fixture.workspaceA,
        eventId: fixture.eventA,
      }).schedule;
      const fingerprint = readCurrentScheduleApproval(fixture.db, {
        workspaceId: fixture.workspaceA,
        eventId: fixture.eventA,
      })!.scheduleAuthorityFingerprint;
      const before = approvalEventCount(fixture.db);
      const form = approvalFormFor(fixture.eventA, schedule.revision, fingerprint, "exact-replay");
      const created = await approveScheduleDraftAction(form);
      expect(created).toMatchObject({ ok: true, code: "SCHEDULE_APPROVED" });
      const replayed = await approveScheduleDraftAction(form);
      expect(replayed).toMatchObject({ ok: true, code: "SCHEDULE_ALREADY_APPROVED" });
      if (created.ok && replayed.ok) {
        expect(replayed.approval.approvalEventId).toBe(created.approval.approvalEventId);
        expect(replayed.approval.approvalAuditId).toBe(created.approval.approvalAuditId);
        expect(replayed.approval.approvalFingerprint).toBe(created.approval.approvalFingerprint);
      }
      expect(approvalEventCount(fixture.db)).toBe(before + 1);
    } finally {
      closeDb(fixture.db);
    }
  });
});
