import { describe, expect, it } from "vitest";

import {
  createSyntheticContentOperationsRepository,
  evaluateContentPublicationGate,
  type ContentPayload,
} from "@/server/services/content-operations";
import {
  buildPublicationPreview,
  createSyntheticPublicationContentRequirements,
  createSyntheticPublicationState,
  publishApprovedSchedule,
} from "@/server/services/public-agenda";
import {
  approveSchedule,
  cloneSchedule,
  type ScheduleSnapshot,
} from "@/server/services/scheduling";

const scope = { workspaceId: "workspace-content-gate", eventId: "event-content-gate" };
const contentScope = { ...scope, actorId: "organizer-content-gate", actorKind: "organizer" as const };

function changedPayload(payload: ContentPayload, suffix: string): ContentPayload {
  switch (payload.kind) {
    case "PROFILE":
      return { ...payload, bio: `${payload.bio} ${suffix}` };
    case "SESSION_TITLE":
      return { ...payload, title: `${payload.title} ${suffix}` };
    case "SESSION_DESCRIPTION":
      return { ...payload, description: `${payload.description} ${suffix}` };
    default:
      return payload;
  }
}

describe("truthful content publication gating", () => {
  it("requires a visible plan approval transition and exact current content approval", () => {
    const state = createSyntheticPublicationState(scope);
    const channel = state.repository.getChannel(scope, state.currentRelease.channelId)!;
    const draft = cloneSchedule(state.approvedSchedule) as ScheduleSnapshot;
    draft.status = "DRAFT";
    draft.approvedAt = null;

    const draftPreview = buildPublicationPreview(draft, channel, {
      audiencePolicyVersion: 1,
      commitmentWatermark: "test-watermark",
      contentGate: state.contentGate,
    });
    expect(draftPreview.state).toBe("BLOCKED");
    expect(draftPreview.blockers).toContain("The source plan is not approved.");

    const approved = approveSchedule(draft, { approvedAt: "2026-08-12T09:30:00.000Z" });
    const approvedPreview = buildPublicationPreview(approved, channel, {
      audiencePolicyVersion: 1,
      commitmentWatermark: "test-watermark",
      contentGate: state.contentGate,
    });
    expect(approvedPreview.state).toBe("READY");

    const requirement = state.contentRequirements[0]!;
    const original = state.contentGate.items.find((item) => item.requirement.id === requirement.id)!;
    const changed = state.contentRepository.submitVersion(contentScope, {
      personId: requirement.personId,
      taskId: requirement.taskId,
      payload: changedPayload(original.approvedPayload!, "pending"),
    });
    state.contentRepository.approveVersion(contentScope, {
      personId: requirement.personId,
      taskId: requirement.taskId,
      submissionVersionId: changed.id,
      submissionContentHash: changed.contentHash,
      gate: "CONFIRMATION",
    });
    const pendingGate = evaluateContentPublicationGate(state.contentRepository, contentScope, state.contentRequirements);
    const pendingItem = pendingGate.items.find((item) => item.requirement.id === requirement.id)!;
    expect(pendingItem.status).toBe("PENDING");
    expect(pendingItem.currentVersionId).toBe(changed.id);
    expect(pendingGate.state).toBe("BLOCKED");

    state.contentRepository.addFinding(contentScope, {
      personId: requirement.personId,
      taskId: requirement.taskId,
      submissionVersionId: changed.id,
      submissionContentHash: changed.contentHash,
      severity: "BLOCKER",
      message: "The current public item needs revision.",
    });
    const rejectedGate = evaluateContentPublicationGate(state.contentRepository, contentScope, state.contentRequirements);
    expect(rejectedGate.items.find((item) => item.requirement.id === requirement.id)?.status).toBe("REJECTED");

    const revised = state.contentRepository.submitVersion(contentScope, {
      personId: requirement.personId,
      taskId: requirement.taskId,
      payload: changedPayload(changed.payload, "revised"),
    });
    state.contentRepository.approveVersion(contentScope, {
      personId: requirement.personId,
      taskId: requirement.taskId,
      submissionVersionId: revised.id,
      submissionContentHash: revised.contentHash,
      gate: "PUBLICATION",
    });
    const readyGate = evaluateContentPublicationGate(state.contentRepository, contentScope, state.contentRequirements);
    expect(readyGate.state).toBe("READY");
    expect(readyGate.items.find((item) => item.requirement.id === requirement.id)).toMatchObject({
      status: "APPROVED",
      currentVersionId: revised.id,
      approvedVersionId: revised.id,
      currentContentHash: revised.contentHash,
      approvedContentHash: revised.contentHash,
    });
  });

  it("blocks sealing on a stale gate and preserves exact approved evidence in each release", () => {
    const state = createSyntheticPublicationState({ workspaceId: "workspace-content-release", eventId: "event-content-release" });
    const first = state.currentRelease;
    const requirement = state.contentRequirements[0]!;
    const original = state.contentGate.items.find((item) => item.requirement.id === requirement.id)!;
    const changed = state.contentRepository.submitVersion(
      { workspaceId: state.approvedSchedule.workspaceId, eventId: state.approvedSchedule.eventId, actorId: "organizer-content-release", actorKind: "organizer" },
      {
        personId: requirement.personId,
        taskId: requirement.taskId,
        payload: changedPayload(original.approvedPayload!, "unapproved"),
      },
    );
    const blockedGate = evaluateContentPublicationGate(
      state.contentRepository,
      { workspaceId: state.approvedSchedule.workspaceId, eventId: state.approvedSchedule.eventId, actorId: "organizer-content-release", actorKind: "organizer" },
      state.contentRequirements,
    );
    expect(() => publishApprovedSchedule(state.repository, state.approvedSchedule, {
      scope: { workspaceId: state.approvedSchedule.workspaceId, eventId: state.approvedSchedule.eventId },
      channelId: first.channelId,
      audiencePolicyVersion: first.audiencePolicyVersion,
      commitmentWatermark: "synthetic-commitment-watermark-v2",
      publishedAt: "2026-08-12T10:00:00.000Z",
      idempotencyKey: "blocked-content-release",
      contentGate: blockedGate,
    })).toThrow(/not approved|not ready|revision/u);
    expect(state.repository.getRelease(scopeFor(state), first.id)?.contentGateFingerprint).toBe(first.contentGateFingerprint);
    expect(first.contentGate?.items.find((item) => item.requirement.id === requirement.id)?.approvedVersionId).toBe(original.approvedVersionId);
    expect(changed.id).not.toBe(original.approvedVersionId);

    const releaseScope = scopeFor(state);
    const releaseContentScope = { ...releaseScope, actorId: "organizer-content-release", actorKind: "organizer" as const };
    state.contentRepository.approveVersion(releaseContentScope, {
      personId: requirement.personId,
      taskId: requirement.taskId,
      submissionVersionId: changed.id,
      submissionContentHash: changed.contentHash,
      gate: "PUBLICATION",
    });
    const readyGate = evaluateContentPublicationGate(state.contentRepository, releaseContentScope, state.contentRequirements);
    const second = publishApprovedSchedule(state.repository, state.approvedSchedule, {
      scope: releaseScope,
      channelId: first.channelId,
      audiencePolicyVersion: first.audiencePolicyVersion,
      commitmentWatermark: "synthetic-commitment-watermark-v2",
      publishedAt: "2026-08-12T10:05:00.000Z",
      idempotencyKey: "approved-content-release",
      contentGate: readyGate,
    });
    expect(second.created).toBe(true);
    expect(second.release.contentGateFingerprint).toBe(readyGate.fingerprint);
    expect(second.release.contentGate?.items.find((item) => item.requirement.id === requirement.id)).toMatchObject({
      approvedVersionId: changed.id,
      approvedContentHash: changed.contentHash,
    });
    expect(state.repository.getRelease(releaseScope, first.id)?.contentGateFingerprint).toBe(first.contentGateFingerprint);
  });
});

function scopeFor(state: ReturnType<typeof createSyntheticPublicationState>) {
  return { workspaceId: state.approvedSchedule.workspaceId, eventId: state.approvedSchedule.eventId };
}
