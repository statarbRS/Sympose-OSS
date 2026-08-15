import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FatalError extends Error {
    readonly fatal = true;
  }

  return {
    FatalError,
    db: { queuePolishDb: true },
    closeDb: vi.fn(),
    getDb: vi.fn(),
    getRouteSession: vi.fn(),
    requireReviewerWorkspaceRoute: vi.fn(),
    listOwnReviewAssignments: vi.fn(),
  };
});

vi.mock("@/server/db", () => ({
  closeDb: mocks.closeDb,
  getDb: mocks.getDb,
}));

vi.mock("@/server/workspace-session", () => ({
  getRouteSession: mocks.getRouteSession,
  requireReviewerWorkspaceRoute: mocks.requireReviewerWorkspaceRoute,
}));

vi.mock("@/server/services/cfp-review", () => ({
  ReviewerServiceFatalError: mocks.FatalError,
  listOwnReviewAssignments: mocks.listOwnReviewAssignments,
}));

import ReviewerQueuePage from "@/app/review/[workspace]/queue/page";

const session = {
  workspaceSlug: "northstar",
};

const summary = {
  assignmentId: "assignment-first",
  roundName: "Community review round",
  assignedAt: "2026-08-11T09:00:00.000Z",
  assignmentState: "ASSIGNED",
  assignmentStateSequenceNumber: 1,
  conflictStatus: "NONE",
  conflictSequenceNumber: 0,
  latestReviewRevisionNumber: 0,
  actionBlocked: false,
} as const;

describe("reviewer queue bounded presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue(mocks.db);
    mocks.getRouteSession.mockResolvedValue(session);
  });

  it("labels every card with a blind-safe proposal ordinal while retaining exact authorized hrefs", async () => {
    const first = { ...summary };
    const second = {
      ...summary,
      assignmentId: "assignment/second",
      assignmentState: "SUBMITTED" as const,
      latestReviewRevisionNumber: 2,
      actionBlocked: true,
    };
    mocks.listOwnReviewAssignments.mockReturnValue([first, second]);

    const element = await ReviewerQueuePage({
      params: Promise.resolve({ workspace: "northstar" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Blind proposal 1 of 2 · Community review round");
    expect(html).toContain("Blind proposal 2 of 2 · Community review round");
    expect(html).toContain('href="/review/northstar/assignments/assignment-first"');
    expect(html).toContain('href="/review/northstar/assignments/assignment%2Fsecond"');
    expect(html).not.toContain("Applicant Secret Name");
    expect(first.roundName).toBe("Community review round");
    expect(second.roundName).toBe("Community review round");
    expect(mocks.listOwnReviewAssignments).toHaveBeenCalledWith(mocks.db, session, {
      workspaceSlug: "northstar",
    });
    expect(mocks.requireReviewerWorkspaceRoute).toHaveBeenCalledWith(session, "northstar");
  });

  it("removes the repeated visible position line and any large queue minimum-height reservation", () => {
    const css = readFileSync(resolve("src/app/review/review.css"), "utf8");

    expect(css).toMatch(/\.review-queue-card__position\s*\{[^}]*display:\s*none;/u);
    expect(css).toMatch(/\.review-queue-list\s*\{[^}]*max-width:\s*720px;/u);
    expect(css).toMatch(/\.review-queue-card\s*\{[^}]*min-height:\s*0;/u);
    expect(css).not.toMatch(/\.review-root\s*\{[^}]*min-height:\s*100vh;/u);
  });
});
