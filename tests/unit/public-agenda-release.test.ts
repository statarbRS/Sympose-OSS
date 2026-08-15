import { describe, expect, it } from "vitest";

import {
  createCalendarExport,
  createItinerary,
  createSyntheticPublicationContentAuthority,
  createSyntheticPublicationState,
  getCurrentPublicProjection,
  getReleaseForOrganizer,
  isPublicEventProjection,
  publishApprovedSchedule,
} from "@/server/services/public-agenda";
import {
  approveSchedule,
  cloneSchedule,
  createSyntheticScheduleProjection,
  createSyntheticApprovedScheduleProjection,
  detectScheduleConflicts,
  scheduleContentFingerprint,
  type ApprovedScheduleSnapshot,
} from "@/server/services/scheduling";

const scope = { workspaceId: "workspace-public-a", eventId: "event-public-a" };

describe("immutable public agenda releases", () => {
  it("publishes only approved conflict-free source and redacts organizer fields", () => {
    const state = createSyntheticPublicationState(scope);
    const release = state.currentRelease;
    const serialized = JSON.stringify(release.projection);

    expect(release.releaseNumber).toBe(1);
    expect(release.supersedesReleaseId).toBeNull();
    expect(release.projection.sessions).toHaveLength(6);
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("Organizer notes");
    expect(serialized).not.toContain("privateNotes");
    expect(serialized).not.toContain("internalScore");
    expect(release.projection.redaction.omittedFields).toContain("Speaker email");
    expect(isPublicEventProjection(release.projection)).toBe(true);
  });

  it("keeps the channel pointer stable on idempotent retry and supersedes without rewriting history", () => {
    const state = createSyntheticPublicationState(scope);
    const first = state.currentRelease;
    const replay = publishApprovedSchedule(state.repository, state.approvedSchedule, {
      scope,
      channelId: first.channelId,
      audiencePolicyVersion: first.audiencePolicyVersion,
      commitmentWatermark: first.commitmentWatermark,
      publishedAt: "2026-08-12T09:00:00.000Z",
      idempotencyKey: "same-operation-replay",
    });
    expect(replay.created).toBe(false);
    expect(replay.release.id).toBe(first.id);

    const next = cloneSchedule(state.approvedSchedule) as ApprovedScheduleSnapshot;
    next.planVersionId = "synthetic-approved-v2";
    next.sessions[0]!.title = "Trust is a schedule · revised";
    next.planFingerprint = scheduleContentFingerprint(next);
    expect(() => publishApprovedSchedule(state.repository, next, {
      scope,
      channelId: first.channelId,
      audiencePolicyVersion: first.audiencePolicyVersion,
      commitmentWatermark: "synthetic-commitment-watermark-v2",
      publishedAt: "2026-08-12T10:00:00.000Z",
      idempotencyKey: "publish-v2-without-content-authority",
    })).toThrow(/content approval evidence/u);
    const nextContent = createSyntheticPublicationContentAuthority(next);
    const second = publishApprovedSchedule(state.repository, next, {
      scope,
      channelId: first.channelId,
      audiencePolicyVersion: first.audiencePolicyVersion,
      commitmentWatermark: "synthetic-commitment-watermark-v2",
      publishedAt: "2026-08-12T10:00:00.000Z",
      idempotencyKey: "publish-v2",
      contentGate: nextContent.gate,
    });

    expect(second.created).toBe(true);
    expect(second.release.releaseNumber).toBe(2);
    expect(second.release.supersedesReleaseId).toBe(first.id);
    expect(getCurrentPublicProjection(state.repository, scope, first.channelId)?.release.releaseNumber).toBe(2);
    expect(getReleaseForOrganizer(state.repository, scope, first.id)?.projection.sessions[0]?.title).toBe("Trust is a schedule");
  });

  it("does not disclose another tenant's channel or release", () => {
    const state = createSyntheticPublicationState(scope);
    const otherScope = { workspaceId: "workspace-public-b", eventId: "event-public-a" };
    expect(state.repository.getCurrentRelease(otherScope, state.currentRelease.channelId)).toBeNull();
    expect(state.repository.getRelease(otherScope, state.currentRelease.id)).toBeNull();
    expect(getCurrentPublicProjection(state.repository, otherScope, state.currentRelease.channelId)).toBeNull();
  });

  it("blocks a draft with conflicts before it can become a release", () => {
    const draft = createSyntheticScheduleProjection(scope);
    const state = createSyntheticPublicationState(scope);
    expect(detectScheduleConflicts(draft).length).toBeGreaterThan(0);
    expect(() => approveSchedule(draft, { approvedAt: "2026-08-12T09:30:00.000Z" })).toThrow(/conflict/);
    expect(state.currentRelease.releaseNumber).toBe(1);
  });

  it("provides an audience-safe calendar contract and deterministic itinerary", () => {
    const state = createSyntheticPublicationState(scope);
    const projection = state.currentRelease.projection;
    const trustSession = projection.sessions.find((session) => session.title.startsWith("Trust is a schedule"));
    const promiseSession = projection.sessions.find((session) => session.title.startsWith("The release is a promise"));
    if (!trustSession || !promiseSession) throw new Error("synthetic public itinerary sessions missing");
    const favorites = [promiseSession.slug, trustSession.slug];
    const itinerary = createItinerary(projection, favorites);
    const calendar = createCalendarExport(projection, itinerary[0]!.slug);

    expect(itinerary.map((item) => item.slug)).toEqual([trustSession.slug, promiseSession.slug]);
    expect(calendar?.calendar.mimeType).toBe("text/calendar");
    expect(calendar?.calendar.content).toContain("BEGIN:VEVENT");
    expect(calendar?.calendar.content).toContain("SUMMARY:");
    expect(calendar?.calendar.content).not.toContain("private@example.test");
  });

  it("rejects a forged stored projection carrying forbidden internal keys", () => {
    const state = createSyntheticPublicationState(scope);
    const forged = JSON.parse(JSON.stringify(state.currentRelease.projection)) as Record<string, unknown>;
    (forged.sessions as Array<Record<string, unknown>>)[0]!.email = "leak@example.test";
    expect(isPublicEventProjection(forged)).toBe(false);

    const legacy = JSON.parse(JSON.stringify(state.currentRelease.projection)) as Record<string, unknown>;
    (legacy.event as Record<string, unknown>).slug = "public-event-slug";
    expect(isPublicEventProjection(legacy)).toBe(false);
  });

  it("keeps the approved source separate from the mutable draft fixture", () => {
    const approved = createSyntheticApprovedScheduleProjection(scope);
    const draft = createSyntheticScheduleProjection(scope);
    expect(approved.status).toBe("APPROVED");
    expect(draft.status).toBe("DRAFT");
    expect(draft.planVersionId).not.toBe(approved.planVersionId);
  });
});
