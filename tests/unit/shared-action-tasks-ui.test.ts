import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import type { SharedActionTasksSurface } from "@/app/w/[workspace]/events/[eventId]/speakers/actions";
import { SharedActionTasksPanel } from "@/components/shared-action-tasks-panel";

const surface: SharedActionTasksSurface = {
  workspace: "acme",
  event: { id: "event-action-ui", name: "Evidence Forum" },
  speakers: [
    { personId: "person-noor", fullName: "Noor Haddad", role: "SPEAKER", assignmentId: "assignment-noor" },
    { personId: "person-iris", fullName: "Iris Cole", role: "MODERATOR", assignmentId: "assignment-iris" },
  ],
  batches: [
    {
      schema: "speaker-shared-action-task/v1",
      definitionId: "definition-action-1",
      workspaceId: "workspace-acme",
      eventId: "event-action-ui",
      title: "Confirm arrival details",
      instructions: "Review the event brief and confirm your arrival window.",
      dueDate: "2026-08-15",
      dueAt: "2026-08-15T23:59:59.999Z",
      createdAt: "2026-08-13T12:00:00.000Z",
      requestFingerprint: "fingerprint-action-1",
      assignmentCount: 2,
      completedCount: 1,
      assignments: [
        { taskId: "task-noor", personId: "person-noor", assignmentId: "assignment-noor", speakerName: "Noor Haddad", state: "COMPLETED" },
        { taskId: "task-iris", personId: "person-iris", assignmentId: "assignment-iris", speakerName: "Iris Cole", state: "NOT_STARTED" },
      ],
    },
  ],
  reminders: [
    {
      messageId: "message-action-1",
      domainEventId: "event-reminder-1",
      workspaceId: "workspace-acme",
      eventId: "event-action-ui",
      definitionId: "definition-action-1",
      taskId: "task-iris",
      assignmentId: "assignment-iris",
      recipientPersonId: "person-iris",
      recipientName: "Iris Cole",
      recipientEmail: "iris@example.test",
      occurrenceDate: "2026-08-13",
      eventName: "Evidence Forum",
      taskTitle: "Confirm arrival details",
      taskInstructions: "Review the event brief and confirm your arrival window.",
      dueDate: "2026-08-15",
      dueAt: "2026-08-15T23:59:59.999Z",
      subjectPreview: "Action due: Confirm arrival details",
      bodyPreview: "Evidence Forum\n\nConfirm arrival details\nDue 2026-08-15 UTC",
      destinationKey: "local:speaker-action-task-reminder:event-action-ui:task-iris:2026-08-13",
      payloadFingerprint: "fingerprint-reminder-1",
      status: "PENDING",
      attemptCount: 0,
      nextAttemptAt: "2026-08-13T12:00:00.000Z",
      createdAt: "2026-08-13T12:00:00.000Z",
      deliveredAt: null,
      lastErrorRecorded: false,
      providerReceiptId: null,
      providerAcceptedAt: null,
      deliveryMode: null,
      channel: "local",
      providerMutation: false,
    },
  ],
  nextIdempotencyKey: "shared-action-ui-key",
  minimumDueDate: "2026-08-13",
  defaultDueDate: "2026-08-15",
  maximumDueDate: "2027-08-14",
  minimumAssignees: 2,
  maximumAssignees: 100,
  maximumInstructions: 2_000,
  maximumReminderAssignments: 100,
};

describe("shared ACTION task organizer UI", () => {
  it("renders two-speaker selection, aggregate/per-speaker state, bounded UTC dates, and truthful durable reminder evidence", () => {
    const html = renderToStaticMarkup(createElement(SharedActionTasksPanel, { surface }));

    expect(html).toContain('data-testid="shared-action-tasks-panel"');
    expect(html).toContain("General ACTION tasks");
    expect(html).toContain("2 selected · 2 current · maximum 100");
    expect(html).toContain("Select up to 100");
    expect(html).toMatch(/name="personId" checked="" value="person-noor"/u);
    expect(html).toMatch(/name="personId" checked="" value="person-iris"/u);
    expect(html).toMatch(/maxLength="240" required="" name="title"/u);
    expect(html).toContain('name="instructions" maxLength="2000"');
    expect(html).toMatch(/type="date" min="2026-08-13" max="2027-08-14" required="" name="dueDate" value="2026-08-15"/u);
    expect(html).toContain("1/2 complete");
    expect(html).toContain("task-noor");
    expect(html).toContain("COMPLETED");
    expect(html).toContain("task-iris");
    expect(html).toContain("NOT_STARTED");
    expect(html).toContain("Queue due reminders");
    expect(html).toContain("exclusive seven-day upper boundary");
    expect(html).toContain("scans at most 100 assignments");
    expect(html).toContain("PENDING outbox only");
    expect(html).toContain("Iris Cole");
    expect(html).toContain("iris@example.test");
    expect(html).toContain("current canonical display");
    expect(html).toContain("Durable recipient Person person-iris");
    expect(html).toContain("Attempts 0 · provider mutation false");
    expect(html).toContain("Local queue only · no provider contacted");
    expect(html).toContain("maximum 100");
    expect(html).not.toContain("SIMULATED_DELIVERED");
    expect(html).not.toContain("Send simulated bulk reminder");
  });

  it("removes the old process-local reminder mutation while keeping invitation simulation separate", () => {
    const roster = readFileSync(resolve("src/components/speaker-ops/speaker-roster.tsx"), "utf8");
    const actions = readFileSync(resolve("src/app/w/[workspace]/events/[eventId]/speakers/actions.ts"), "utf8");

    expect(roster).not.toContain("sendSpeakerReminder");
    expect(roster).not.toContain("Send simulated bulk reminder");
    expect(actions).not.toContain("export async function sendSpeakerReminder");
    expect(roster).toContain("sendSpeakerInvitation");
    expect(roster).toContain("simulated delivery evidence");
    expect(roster).toContain('task.kind === "ACTION" && task.state !== "COMPLETED"');
    expect(roster).toContain("Due reminders for this shared ACTION assignment");
    expect(roster).not.toContain("Due reminders are queued from the shared ACTION task scheduler");
    expect(readFileSync(resolve("src/components/shared-action-tasks-panel.tsx"), "utf8")).toContain("currentSelectionSize");
    expect(actions).toContain("queueActionTaskRemindersAction");
    expect(actions).toContain("No provider was contacted");
  });

  it("checks only the first 100 of 101 current speakers and disables the overflow recipient", () => {
    const speakers = Array.from({ length: 101 }, (_, index) => ({
      personId: `bounded-person-${String(index).padStart(3, "0")}`,
      fullName: `Bounded Speaker ${index}`,
      role: "SPEAKER" as const,
      assignmentId: `bounded-assignment-${String(index).padStart(3, "0")}`,
    }));
    const html = renderToStaticMarkup(createElement(SharedActionTasksPanel, {
      surface: { ...surface, speakers, batches: [], reminders: [] },
    }));
    const checkboxes = html.match(/<input type="checkbox"[^>]+>/gu) ?? [];

    expect(checkboxes).toHaveLength(101);
    expect(checkboxes.slice(0, 100).every((checkbox) => checkbox.includes('checked=""'))).toBe(true);
    expect(checkboxes[100]).toContain('value="bounded-person-100"');
    expect(checkboxes[100]).toContain('disabled=""');
    expect(checkboxes[100]).not.toContain('checked=""');
    expect(html).toContain("100 selected · 101 current · maximum 100");
  });
});
