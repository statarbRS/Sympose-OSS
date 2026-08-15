import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlanStudio } from "@/app/w/[workspace]/events/[eventId]/plan/plan-studio";
import { ScheduleBuilder } from "@/components/schedule-builder/schedule-builder";
import type { PlanDetail } from "@/server/services/planning";
import { createSyntheticApprovedScheduleProjection, createSyntheticScheduleProjection } from "@/server/services/scheduling/synthetic";

type AssignmentSpec = {
  personId: string;
  fullName: string;
  programUnitId: string;
  programUnitName: string;
  assignmentType: string;
  explanation: string;
};

function makeDetail(
  id: string,
  versionNumber: number,
  status: string,
  specs: readonly AssignmentSpec[],
): PlanDetail {
  const assignments = specs.map((spec) => ({
    personId: spec.personId,
    programUnitId: spec.programUnitId,
    assignmentType: spec.assignmentType,
    explanation: spec.explanation,
  }));

  return {
    version: {
      id,
      runId: "run-" + id,
      versionNumber,
      fingerprint: "fingerprint-" + id,
      assignmentCount: assignments.length,
      runStatus: "FEASIBLE",
      status,
      createdAt: "2026-08-12T09:00:00.000Z",
      eventId: "event-1",
    },
    content: {
      schema: "plan-content/v1",
      eventId: "event-1",
      eventName: "Synthetic Symposium",
      runId: "run-" + id,
      inputFingerprint: "input-" + id,
      snapshotFingerprint: "snapshot-" + id,
      versionNumber,
      assignments,
      exclusions: [],
      diagnostics: {
        messages: [],
        unitCounts: { "Morning circle": assignments.length },
        moderatorsWithoutUnit: [],
      },
    },
    assignmentsJoined: specs.map((spec) => ({
      ...spec,
      email: spec.personId + "@example.test",
      organization: "Synthetic Org",
    })),
    run: {
      id: "run-" + id,
      status: "FEASIBLE",
      inputFingerprint: "input-" + id,
      compiler: "fixture-compiler",
      compilerVersion: "1",
      createdAt: "2026-08-12T09:00:00.000Z",
    },
    approvals: status === "approved"
      ? [{ id: "approval-" + id, createdAt: "2026-08-12T10:00:00.000Z", actorAccountId: "organizer-1" }]
      : [],
    states: [
      { state: "candidate", createdAt: "2026-08-12T09:00:00.000Z", reason: null },
      ...(status === "approved"
        ? [{ state: "approved", createdAt: "2026-08-12T10:00:00.000Z", reason: "Reviewed" }]
        : []),
    ],
  };
}

const approved = makeDetail("approved", 1, "approved", [
  {
    personId: "person-1",
    fullName: "Ada Lovelace",
    programUnitId: "unit-1",
    programUnitName: "Morning circle",
    assignmentType: "Moderator",
    explanation: "Moderator-eligible per fixture evidence",
  },
  {
    personId: "person-2",
    fullName: "Grace Hopper",
    programUnitId: "unit-2",
    programUnitName: "Afternoon circle",
    assignmentType: "Participant",
    explanation: "Capacity fit",
  },
]);

const candidate = makeDetail("candidate", 2, "candidate", [
  {
    personId: "person-1",
    fullName: "Ada Lovelace",
    programUnitId: "unit-1",
    programUnitName: "Morning circle",
    assignmentType: "Moderator",
    explanation: "Moderator-eligible per fixture evidence",
  },
  {
    personId: "person-2",
    fullName: "Grace Hopper",
    programUnitId: "unit-3",
    programUnitName: "Closing circle",
    assignmentType: "Participant",
    explanation: "Capacity fit after movement",
  },
  {
    personId: "person-3",
    fullName: "Katherine Johnson",
    programUnitId: "unit-4",
    programUnitName: "New circle",
    assignmentType: "Participant",
    explanation: "New eligible record",
  },
]);

describe("Plan Studio rendered surface", () => {
  it("renders the v9 table models, contextual inspector, pane switcher, and exact comparison", () => {
    const html = renderToStaticMarkup(createElement(PlanStudio, {
      workspace: "northstar",
      event: { id: "event-1", name: "Synthetic Symposium" },
      detail: candidate,
      approvedDetail: approved,
    }));

    expect(html).toContain('data-testid="plan-review"');
    expect(html).toContain("Candidate v2 vs approved v1");
    expect(html).toContain('data-testid="plan-comparison-unchanged"');
    expect(html).toContain('data-testid="plan-comparison-added-or-moved"');
    expect(html).toContain('data-testid="plan-comparison-removed"');
    expect(html).toContain(">1</dd>");
    expect(html).toContain(">2</dd>");
    expect(html).toContain("Select");
    expect(html).toContain("Person");
    expect(html).toContain("Program unit");
    expect(html).toContain("Compiler explanation");
    expect(html).toContain('aria-label="Plan Studio pane switcher"');
    expect(html).toContain('aria-controls="plan-pane-inputs"');
    expect(html).toContain('aria-controls="plan-pane-assignments"');
    expect(html).toContain('aria-controls="plan-pane-diagnostics"');
    expect(html).toContain("Select an assignment row to inspect its person, program unit, role, and compiler explanation.");
  });

  it("states approved-only and no-plan records without inventing a comparison", () => {
    const approvedHtml = renderToStaticMarkup(createElement(PlanStudio, {
      workspace: "northstar",
      event: { id: "event-1", name: "Synthetic Symposium" },
      detail: approved,
      approvedDetail: null,
    }));
    const emptyHtml = renderToStaticMarkup(createElement(PlanStudio, {
      workspace: "northstar",
      event: { id: "event-1", name: "Synthetic Symposium" },
      detail: null,
    }));

    expect(approvedHtml).toContain("Approved current record is shown; no separate unapproved candidate is available.");
    expect(approvedHtml).not.toContain("Exact record comparison");
    expect(emptyHtml).toContain("No plan record yet");
    expect(emptyHtml).toContain("There is no unapproved candidate or approved current plan for this event.");
  });
});

describe("Plan Studio scheduling instrument", () => {
  it("keeps direct manipulation, keyboard parity, conflicts, checksum, and consequence together", () => {
    const schedule = createSyntheticScheduleProjection({
      workspaceId: "workspace-plan-studio",
      eventId: "event-plan-studio",
    });
    const html = renderToStaticMarkup(createElement(ScheduleBuilder, {
      initialSchedule: schedule,
      initialPersistence: "saved",
      initialScheduleAuthorityFingerprint: "a".repeat(64),
      initialApproval: null,
      saveDraftAction: async () => { throw new Error("not invoked during render"); },
      approveDraftAction: async () => { throw new Error("not invoked during render"); },
      workspaceSlug: "northstar",
    }));

    expect(html).toContain("Move without dragging");
    expect(html).toContain("No drag required");
    expect(html).toContain('data-testid="direct-placement-control"');
    expect(html).toContain('role="region"');
    expect(html).toContain("schedule grid. Scroll horizontally for every room.");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("Explainable conflicts");
    expect(html).toContain("Approval subject checksum");
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("Any later schedule edit makes that approval stale");
    expect(html).toContain("Publication workspace blocked");
  });

  it("puts the inspector first on narrow screens and preserves reduced-motion and touch rules", () => {
    const css = readFileSync(resolve("src/components/schedule-builder/schedule-builder.module.css"), "utf8");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toMatch(/\.builderLayout > \.inspector\s*\{\s*order: -1;/u);
    expect(css).toMatch(/\.mobileParityLink\s*\{\s*display: inline-flex;/u);
    expect(css).toContain("min-height: 2.75rem");
    expect(css).toContain("prefers-reduced-motion");
  });

  it("explains why auto-schedule is disabled when every session is already placed", () => {
    const schedule = createSyntheticApprovedScheduleProjection({
      workspaceId: "workspace-plan-studio",
      eventId: "event-plan-studio-placed",
    });
    const html = renderToStaticMarkup(createElement(ScheduleBuilder, {
      initialSchedule: schedule,
      initialPersistence: "saved",
      initialScheduleAuthorityFingerprint: "b".repeat(64),
      initialApproval: null,
      saveDraftAction: async () => { throw new Error("not invoked during render"); },
      approveDraftAction: async () => { throw new Error("not invoked during render"); },
      workspaceSlug: "northstar",
    }));

    expect(html).toContain("Auto-schedule unavailable · all sessions are placed");
    expect(html).toMatch(/data-testid="auto-schedule-control"[^>]*disabled/u);
  });
});
