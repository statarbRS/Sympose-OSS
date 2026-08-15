import type { SessionInfo } from "@/server/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(() => ({ kind: "inert-test-db" })),
  getEvent: vi.fn(),
  getRouteSession: vi.fn<() => Promise<SessionInfo>>(),
  notFound: vi.fn(() => {
    throw Object.assign(new Error("route not found"), { digest: "NEXT_NOT_FOUND" });
  }),
  redirect: vi.fn(() => {
    throw Object.assign(new Error("route redirect"), { digest: "NEXT_REDIRECT" });
  }),
  revalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  return { ...actual, getDb: mocks.getDb };
});
vi.mock("@/server/services/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/events")>();
  return { ...actual, getEvent: mocks.getEvent };
});
vi.mock("@/server/workspace-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/workspace-session")>();
  return { ...actual, getRouteSession: mocks.getRouteSession };
});

import {
  createSharedActionTaskAction,
  queueActionTaskRemindersAction,
} from "@/app/w/[workspace]/events/[eventId]/speakers/actions";

const ORGANIZER: SessionInfo = {
  id: "session-organizer",
  tokenHash: "session-organizer-hash",
  accountId: "account-organizer",
  workspaceId: "workspace-northstar",
  expiresAt: "2099-01-01T00:00:00.000Z",
  email: "organizer@example.test",
  displayName: "Organizer",
  role: "organizer",
  workspaceSlug: "northstar",
  workspaceName: "Northstar",
};

const REVIEWER: SessionInfo = { ...ORGANIZER, accountId: "account-reviewer", role: "reviewer" };

function actionForm(workspace = "northstar", eventId = "event-action"): FormData {
  const form = new FormData();
  form.set("workspace", workspace);
  form.set("eventId", eventId);
  form.set("title", "Confirm arrival details");
  form.set("instructions", "Review the brief and confirm arrival details.");
  form.set("dueDate", "2026-08-15");
  form.set("idempotencyKey", "route-boundary-command");
  form.append("personId", "person-a");
  form.append("personId", "person-b");
  return form;
}

const commands = [
  {
    label: "shared ACTION creation",
    run: (form: FormData) => createSharedActionTaskAction({ kind: "idle" }, form),
  },
  {
    label: "due reminder scheduling",
    run: (form: FormData) => queueActionTaskRemindersAction({ kind: "idle" }, form),
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue({ kind: "inert-test-db" });
  mocks.getEvent.mockReturnValue(null);
  mocks.getRouteSession.mockResolvedValue(ORGANIZER);
});

describe("shared ACTION task server-action authorization", () => {
  it.each(commands)("denies unauthenticated $label before any database access", async ({ run }) => {
    mocks.getRouteSession.mockRejectedValueOnce(
      Object.assign(new Error("session expired"), { digest: "NEXT_REDIRECT" }),
    );

    await expect(run(actionForm())).rejects.toMatchObject({ digest: "NEXT_REDIRECT" });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getEvent).not.toHaveBeenCalled();
  });

  it.each(commands)("denies reviewer $label before any database access", async ({ run }) => {
    mocks.getRouteSession.mockResolvedValueOnce(REVIEWER);

    await expect(run(actionForm())).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getEvent).not.toHaveBeenCalled();
  });

  it.each(commands)("denies a foreign-workspace $label before any database access", async ({ run }) => {
    await expect(run(actionForm("foreign-workspace"))).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getEvent).not.toHaveBeenCalled();
  });

  it.each(commands)("fails closed for a wrong-event $label before reaching the task repository", async ({ run }) => {
    const result = await run(actionForm("northstar", "event-foreign"));

    expect(result).toMatchObject({ kind: "error", code: "SHARED_ACTION_TASK_FAILED" });
    expect(mocks.getDb).toHaveBeenCalledOnce();
    expect(mocks.getEvent).toHaveBeenCalledWith(
      { kind: "inert-test-db" },
      ORGANIZER.workspaceId,
      "event-foreign",
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
