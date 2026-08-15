import { describe, expect, it } from "vitest";

import { ContentOperationsConflictError } from "@/server/services/content-operations";
import {
  createSyntheticSpeakerOperationsRepository,
  syntheticSpeakerPortalToken,
  SpeakerOperationsAuthorizationError,
  SpeakerOperationsConflictError,
} from "@/server/services/speaker-operations";

const event = {
  id: "event-speaker-test",
  name: "Synthetic Speaker Forum",
  timezone: "UTC",
  startsAt: "2026-09-15T09:00:00.000Z",
  endsAt: "2026-09-15T17:00:00.000Z",
} as const;

const organizer = {
  kind: "organizer" as const,
  workspaceId: "workspace-speaker-test",
  eventId: event.id,
  actorId: "organizer-test",
};

describe("synthetic speaker and content operations", () => {
  it("builds the organizer roster with seeded profile review and export data", () => {
    const repository = createSyntheticSpeakerOperationsRepository({ clock: () => "2026-08-12T12:00:10.000Z" });

    const projection = repository.getOrganizerProjection(organizer, event);

    expect(projection.roster).toHaveLength(3);
    expect(projection.dashboard.acceptedCommitmentCount).toBe(2);
    expect(projection.dashboard.awaitingResponseCount).toBe(1);
    expect(projection.roster.find((record) => record.person.fullName === "Ada Lovelace")?.profile.pendingRevision).toBeNull();
    expect(projection.roster.find((record) => record.person.fullName === "Cass Nguyen")?.profile.pendingRevision?.reviewState).toBe("BLOCKED");
    expect(projection.download.rowCount).toBe(3);

    const exportResult = repository.exportReadinessCsv(organizer, event);
    expect(exportResult.rowCount).toBe(3);
    expect(exportResult.body).toContain("person_id,person_name,role");
    expect(exportResult.body).toContain("Ada Lovelace");
  });

  it("searches normalized full display names without replacing the evaluator artifact identity", () => {
    const repository = createSyntheticSpeakerOperationsRepository({ clock: () => "2026-08-12T12:00:10.000Z" });

    expect(repository.listSpeakerRoster(organizer, event, { query: "  ADA   LOVELACE  " }).map((record) => record.person.fullName)).toEqual(["Ada Lovelace"]);
  });

  it("exposes the accepted assignment only inside the matching scoped portal", () => {
    const repository = createSyntheticSpeakerOperationsRepository({ clock: () => "2026-08-12T12:00:10.000Z" });
    const roster = repository.listSpeakerRoster(organizer, event);
    const ada = roster.find((record) => record.person.fullName === "Ada Lovelace")!;
    const bruno = roster.find((record) => record.person.fullName === "Bruno Silva")!;
    const adaToken = syntheticSpeakerPortalToken(organizer.workspaceId, event.id, ada.person.personId);

    const portal = repository.getPortalProjection(adaToken)!;

    expect(portal.person.personId).toBe(ada.person.personId);
    expect(portal.assignment.programUnitName).toBe("Responsible Systems in Practice");
    expect(portal.assignment.commitment.state).toBe("ACCEPTED");
    expect(portal.tasks.every((task) => task.personId === ada.person.personId)).toBe(true);
    expect(() => repository.respondToInvitation(adaToken, bruno.invitation.id, "ACCEPTED")).toThrow(SpeakerOperationsAuthorizationError);
  });

  it("keeps content versions immutable while supporting revision and exact approval", () => {
    const repository = createSyntheticSpeakerOperationsRepository({ clock: () => "2026-08-12T12:00:10.000Z" });
    const bruno = repository.listSpeakerRoster(organizer, event).find((record) => record.person.fullName === "Bruno Silva")!;
    const token = syntheticSpeakerPortalToken(organizer.workspaceId, event.id, bruno.person.personId);
    const titleTask = repository.getPortalProjection(token)!.tasks.find((task) => task.kind === "SESSION_TITLE")!;

    const first = repository.submitContent(token, titleTask.id, { kind: "SESSION_TITLE", title: "A bounded session title" }, "title-v1");
    repository.addComment(organizer, {
      personId: bruno.person.personId,
      taskId: titleTask.id,
      submissionVersionId: first.version.id,
      submissionContentHash: first.version.contentHash,
      body: "Please confirm the audience-facing wording.",
      idempotencyKey: "title-comment-v1",
    });
    repository.requestRevision(organizer, {
      personId: bruno.person.personId,
      taskId: titleTask.id,
      submissionVersionId: first.version.id,
      submissionContentHash: first.version.contentHash,
      reason: "Please make the title more specific.",
      idempotencyKey: "title-revision-v1",
    });
    expect(repository.getPortalProjection(token)!.tasks.find((task) => task.id === titleTask.id)?.state).toBe("CHANGES_REQUESTED");

    const second = repository.submitContent(token, titleTask.id, { kind: "SESSION_TITLE", title: "Evidence-aware systems in practice" }, "title-v2");
    const approval = repository.approveContent(organizer, {
      personId: bruno.person.personId,
      taskId: titleTask.id,
      submissionVersionId: second.version.id,
      submissionContentHash: second.version.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: "title-approval-v2",
    });
    const review = repository.getPortalProjection(token)!.tasks.find((task) => task.id === titleTask.id)!.review!;

    expect(review.versions.map((version) => [version.version, version.reviewState])).toEqual([[1, "SUPERSEDED"], [2, "APPROVED"]]);
    expect(approval.submissionVersionId).toBe(second.version.id);
    expect(() => repository.approveContent(organizer, {
      personId: bruno.person.personId,
      taskId: titleTask.id,
      submissionVersionId: first.version.id,
      submissionContentHash: first.version.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: "stale-title-approval",
    })).toThrow(ContentOperationsConflictError);
  });

  it("records organizer invitation/reminder evidence and preserves task controls", () => {
    const repository = createSyntheticSpeakerOperationsRepository({ clock: () => "2026-08-12T12:00:10.000Z" });
    const bruno = repository.listSpeakerRoster(organizer, event).find((record) => record.person.fullName === "Bruno Silva")!;

    const invitation = repository.sendInvitation(organizer, bruno.person.personId, "send-bruno-invitation");
    const reminders = repository.sendReminder(organizer, [bruno.person.personId], "remind-bruno");
    expect(invitation.kind).toBe("INVITATION");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.renderedPreview).toContain("Bruno Silva");

    const briefing = bruno.tasks.find((task) => task.kind === "BRIEFING")!;
    repository.updateTask(organizer, briefing.id, {
      dueAt: "2026-09-13T17:00:00.000Z",
      state: "IN_PROGRESS",
      idempotencyKey: "briefing-control",
    });
    const projection = repository.getOrganizerProjection(organizer, event);
    const updated = projection.roster.find((record) => record.person.personId === bruno.person.personId)!;
    expect(updated.invitation.state).toBe("SENT");
    expect(updated.invitation.deliveryEvidence.id).toBe(invitation.id);
    expect(updated.communications.map((entry) => entry.kind)).toEqual(["INVITATION", "INVITATION", "REMINDER"]);
    expect(updated.tasks.find((task) => task.id === briefing.id)).toMatchObject({ state: "IN_PROGRESS", dueAt: "2026-09-13T17:00:00.000Z" });

    const token = syntheticSpeakerPortalToken(organizer.workspaceId, event.id, bruno.person.personId);
    const completed = repository.completeTask(token, briefing.id, { note: "Ready for the briefing.", idempotencyKey: "complete-bruno-briefing" });
    expect(repository.completeTask(token, briefing.id, { note: "Ready for the briefing.", idempotencyKey: "complete-bruno-briefing" })).toEqual(completed);
    expect(() => repository.completeTask(token, briefing.id, { note: "Different note.", idempotencyKey: "complete-bruno-briefing" })).toThrow(SpeakerOperationsConflictError);
  });

  it("round-trips organizer content, logistics, restore, and metadata-only export", () => {
    const repository = createSyntheticSpeakerOperationsRepository({ clock: () => "2026-08-12T12:00:10.000Z" });
    const bruno = repository.listSpeakerRoster(organizer, event).find((record) => record.person.fullName === "Bruno Silva")!;
    const token = syntheticSpeakerPortalToken(organizer.workspaceId, event.id, bruno.person.personId);
    const titleTask = bruno.tasks.find((task) => task.kind === "SESSION_TITLE")!;
    const logisticsTask = bruno.tasks.find((task) => task.kind === "LOGISTICS")!;
    const first = repository.submitContent(token, titleTask.id, { kind: "SESSION_TITLE", title: "First exact title" }, "bruno-title-v1");
    const second = repository.submitContent(token, titleTask.id, { kind: "SESSION_TITLE", title: "Second exact title" }, "bruno-title-v2");
    const restored = repository.restoreContent(organizer, {
      personId: bruno.person.personId,
      taskId: titleTask.id,
      submissionVersionId: first.version.id,
      submissionContentHash: first.version.contentHash,
      idempotencyKey: "bruno-title-restore",
    });
    repository.submitContent(token, logisticsTask.id, { kind: "LOGISTICS", arrivalWindow: "09:00–09:30", travelMode: "REMOTE", dietaryNotes: "None" }, "bruno-logistics-v1");

    const portal = repository.getPortalProjection(token)!;
    const review = portal.tasks.find((task) => task.id === titleTask.id)!.review!;
    expect(review.versions.map((version) => version.payload.kind === "SESSION_TITLE" ? version.payload.title : "")).toEqual(["First exact title", "Second exact title", "First exact title"]);
    expect(restored.supersedesVersionId).toBe(second.version.id);
    expect(portal.logistics).toMatchObject({ status: "SUBMITTED", arrivalWindow: "09:00–09:30", travelMode: "REMOTE" });

    const exportResult = repository.exportContentMetadata(organizer, event, [restored.id]);
    expect(exportResult.metadataOnly).toBe(true);
    expect(exportResult.body).toContain("file_bytes_available");
    expect(exportResult.body).toContain(",false");
    expect(exportResult.body).toContain(restored.contentHash);
  });
});
