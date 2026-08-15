import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getRouteSession: vi.fn(),
  requireOrganizerWorkspaceRoute: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  return { ...actual, getDb: mocks.getDb };
});
vi.mock("@/server/workspace-session", () => ({
  getRouteSession: mocks.getRouteSession,
  requireOrganizerWorkspaceRoute: mocks.requireOrganizerWorkspaceRoute,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import {
  correctOperationsAttendanceAction,
  recordOperationsAttendanceAction,
} from "@/app/w/[workspace]/events/[eventId]/operations/actions";
import { createSession } from "@/server/auth";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  EVALUATOR_COMPATIBILITY_EVENT_ID,
  EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
  seedEvaluatorDemo,
} from "@/server/evaluator-demo";
import { EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID } from "@/server/evaluator-compatibility";
import { seedWorkspaces } from "@/server/seed";

const OPERATIONS_PATH = `/w/${EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG}/events/${EVALUATOR_COMPATIBILITY_EVENT_ID}/operations`;
const REASON = "Badge scan was attributed to Priya in error.";
const OBSERVED_AT = "2027-09-16T10:15:00.000Z";
const RECORDED_AT = "2027-09-16T10:30:00.000Z";

let db: Db;
let session: ReturnType<typeof createSession>["session"];

function recordForm(): FormData {
  const form = new FormData();
  form.set("personId", EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID);
  form.set("programUnitId", EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID);
  form.set("observedAt", OBSERVED_AT);
  return form;
}

function correctionForm(originalObservationId: string, reason = REASON): FormData {
  const form = new FormData();
  form.set("originalObservationId", originalObservationId);
  form.set("reason", reason);
  return form;
}

function counts(): { readonly observations: number; readonly corrections: number } {
  return {
    observations: (db.prepare("SELECT COUNT(*) AS count FROM observations").get() as { count: number }).count,
    corrections: (db.prepare("SELECT COUNT(*) AS count FROM observation_corrections").get() as { count: number }).count,
  };
}

async function expectRedirect(
  promise: Promise<never>,
  result: string,
  expectedReceipt?: true | string,
): Promise<string | null> {
  await expect(promise).rejects.toThrow("NEXT_REDIRECT:");
  const redirected = mocks.redirect.mock.lastCall?.[0];
  expect(typeof redirected).toBe("string");
  const url = new URL(redirected as string, "http://sympose.test");
  expect(url.pathname).toBe(OPERATIONS_PATH);
  expect(url.searchParams.get("attendanceResult")).toBe(result);
  const receipt = url.searchParams.get("attendanceReceipt");
  if (expectedReceipt === true) {
    expect(receipt).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u);
  } else if (typeof expectedReceipt === "string") {
    expect(receipt).toBe(expectedReceipt);
  } else {
    expect(receipt).toBeNull();
  }
  return receipt;
}

beforeEach(() => {
  db = openDb({ path: ":memory:", seed: false });
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(RECORDED_AT));
  db.prepare(
    "UPDATE events SET lifecycle = 'live' WHERE workspace_id = ? AND id = ?",
  ).run(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
  session = createSession(
    db,
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  ).session;
  mocks.getDb.mockReturnValue(db);
  mocks.getRouteSession.mockResolvedValue(session);
  mocks.requireOrganizerWorkspaceRoute.mockReturnValue(session);
  mocks.revalidatePath.mockReset();
  mocks.redirect.mockClear();
});

afterEach(() => {
  closeDb(db);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("operations observation server actions", () => {
  it("records once, replays exactly, and preserves a durable success when revalidation fails", async () => {
    const before = counts();
    const frameworkForm = recordForm();
    frameworkForm.set("$ACTION_REF_1", "next-transport-reference");
    frameworkForm.set("$ACTION_1:0", "bound-route-transport");
    mocks.revalidatePath.mockImplementationOnce(() => {
      throw new Error("internal revalidation detail");
    });
    const receipt = await expectRedirect(recordOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      frameworkForm,
    ), "record-created", true);
    expect(counts()).toEqual({ observations: before.observations + 1, corrections: before.corrections });
    expect(db.prepare(
      `SELECT observed_at AS observedAt, recorded_at AS recordedAt
       FROM observations WHERE id = ?`,
    ).get(receipt!)).toEqual({ observedAt: OBSERVED_AT, recordedAt: RECORDED_AT });
    expect(mocks.revalidatePath).toHaveBeenLastCalledWith(OPERATIONS_PATH);

    await expectRedirect(recordOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      recordForm(),
    ), "record-replayed", receipt!);
    expect(counts()).toEqual({ observations: before.observations + 1, corrections: before.corrections });
    expect(mocks.requireOrganizerWorkspaceRoute).toHaveBeenCalledWith(
      session,
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
    );
  });

  it("authorizes before parsing and rejects extra or duplicate fields without a write", async () => {
    const before = counts();
    const extra = recordForm();
    extra.set("workspaceId", "caller-supplied-workspace");
    await expectRedirect(recordOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      extra,
    ), "record-invalid");
    expect(counts()).toEqual(before);
    expect(mocks.getRouteSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requireOrganizerWorkspaceRoute.mock.invocationCallOrder[0]!,
    );

    const duplicate = recordForm();
    duplicate.append("personId", EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID);
    await expectRedirect(recordOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      duplicate,
    ), "record-invalid");
    expect(counts()).toEqual(before);

    mocks.getDb.mockClear();
    mocks.getRouteSession.mockRejectedValueOnce(new Error("__UNAUTHENTICATED__"));
    await expect(recordOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      extra,
    )).rejects.toThrow("__UNAUTHENTICATED__");
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(counts()).toEqual(before);

    mocks.getRouteSession.mockResolvedValueOnce(session);
    mocks.requireOrganizerWorkspaceRoute.mockImplementationOnce(() => {
      throw new Error("__ROUTE_SCOPE_DENIED__");
    });
    await expect(recordOperationsAttendanceAction(
      "foreign-workspace",
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      extra,
    )).rejects.toThrow("__ROUTE_SCOPE_DENIED__");
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(counts()).toEqual(before);
  });

  it("maps planning and future-event denial without leaking submitted evidence or writing", async () => {
    db.prepare(
      "UPDATE events SET lifecycle = 'planning' WHERE workspace_id = ? AND id = ?",
    ).run(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
    const beforePlanning = counts();
    await expectRedirect(recordOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      recordForm(),
    ), "record-not-live");
    expect(counts()).toEqual(beforePlanning);

    db.prepare(
      "UPDATE events SET lifecycle = 'live' WHERE workspace_id = ? AND id = ?",
    ).run(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID);
    vi.setSystemTime(new Date("2027-09-15T10:30:00.000Z"));
    const beforeFuture = counts();
    await expectRedirect(recordOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      recordForm(),
    ), "record-time-invalid");
    expect(counts()).toEqual(beforeFuture);
    expect(JSON.stringify(mocks.redirect.mock.calls)).not.toContain(OBSERVED_AT);
  });

  it("creates and replays one correction while mapping conflicts to a payload-free result code", async () => {
    await expectRedirect(recordOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      recordForm(),
    ), "record-created", true);
    const original = db.prepare(
      "SELECT id FROM observations WHERE workspace_id = ? AND source = 'organizer-live-operations'",
    ).get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID) as { id: string };

    const correctionReceipt = await expectRedirect(correctOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      correctionForm(original.id),
    ), "correction-created", true);
    expect(counts()).toEqual({ observations: 2, corrections: 1 });

    await expectRedirect(correctOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      correctionForm(original.id),
    ), "correction-replayed", correctionReceipt!);
    expect(counts()).toEqual({ observations: 2, corrections: 1 });

    const hostileReason = "This conflicting retry must not appear in a redirect or log.";
    await expectRedirect(correctOperationsAttendanceAction(
      EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      correctionForm(original.id, hostileReason),
    ), "correction-conflict");
    expect(counts()).toEqual({ observations: 2, corrections: 1 });
    const serializedRedirects = JSON.stringify(mocks.redirect.mock.calls);
    expect(serializedRedirects).not.toContain(hostileReason);
    expect(serializedRedirects).not.toContain("ATTENDANCE_IDEMPOTENCY_CONFLICT");
  });
});
