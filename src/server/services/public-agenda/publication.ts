import { detectScheduleConflicts } from "../scheduling/deterministic";
import type { ApprovedScheduleSnapshot } from "../scheduling/types";
import type { ContentPublicationGate } from "../content-operations";
import { buildPublicEventProjection, buildPublicationPreview, publicProjectionContentHash } from "./projection";
import { PublicationCommandError } from "./repository";
import type {
  PublicationChannel,
  PublicationPublishInput,
  PublicationRelease,
  PublicationRepository,
  PublicationScope,
  PublicationWriteResult,
} from "./types";

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertPublishable(
  schedule: ApprovedScheduleSnapshot,
  channel: PublicationChannel,
  input: PublicationPublishInput,
  contentGate: ContentPublicationGate | null,
): void {
  if (schedule.workspaceId !== input.scope.workspaceId || schedule.eventId !== input.scope.eventId || channel.workspaceId !== input.scope.workspaceId || channel.eventId !== input.scope.eventId) {
    throw new PublicationCommandError("PUBLICATION_SCOPE_MISMATCH", "The approved plan, channel, and command scope must match.");
  }
  if (schedule.status !== "APPROVED") throw new PublicationCommandError("SOURCE_PLAN_NOT_APPROVED", "Only an approved plan can produce a public release.");
  if (channel.audience !== "PUBLIC") throw new PublicationCommandError("PUBLICATION_AUDIENCE_UNSUPPORTED", "This projection is limited to the public audience.");
  if (!Number.isInteger(input.audiencePolicyVersion) || input.audiencePolicyVersion < 1) throw new PublicationCommandError("AUDIENCE_POLICY_INVALID", "An explicit audience-policy version is required.");
  if (typeof input.commitmentWatermark !== "string" || input.commitmentWatermark.trim().length === 0 || input.commitmentWatermark.length > 200) throw new PublicationCommandError("COMMITMENT_WATERMARK_INVALID", "An explicit bounded commitment watermark is required.");
  if (!validIso(input.publishedAt)) throw new PublicationCommandError("PUBLISHED_AT_INVALID", "Publication time must be a valid ISO timestamp.");
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 200) throw new PublicationCommandError("IDEMPOTENCY_KEY_INVALID", "A bounded idempotency key is required.");
  const conflicts = detectScheduleConflicts(schedule);
  if (conflicts.length > 0) throw new PublicationCommandError("PUBLICATION_SOURCE_CONFLICT", "The approved source contains an unresolved hard schedule conflict.");
  if (schedule.sessions.some((session) => session.public && session.placement === null)) throw new PublicationCommandError("PUBLICATION_SOURCE_UNSCHEDULED", "Every public session must have a placement before publication.");
  if (!contentGate) {
    throw new PublicationCommandError(
      "CONTENT_PUBLICATION_GATE_REQUIRED",
      "A release requires exact current-version content approval evidence.",
    );
  }
  const preview = buildPublicationPreview(schedule, channel, {
    audiencePolicyVersion: input.audiencePolicyVersion,
    commitmentWatermark: input.commitmentWatermark,
    contentGate,
  });
  if (preview.state !== "READY") {
    throw new PublicationCommandError("CONTENT_PUBLICATION_NOT_READY", preview.blockers.join(" "));
  }
}

export function publishApprovedSchedule(
  repository: PublicationRepository,
  schedule: ApprovedScheduleSnapshot,
  input: PublicationPublishInput,
): PublicationWriteResult {
  const channel = repository.getChannel(input.scope, input.channelId);
  if (!channel) throw new PublicationCommandError("PUBLICATION_CHANNEL_NOT_FOUND", "The publication channel is not in the requested scope.");
  const current = repository.getCurrentRelease(input.scope, channel.id);
  // An exact replay may reuse the content evidence sealed into that release.
  // A changed plan must supply a freshly evaluated gate and can never inherit
  // authority from an older release.
  const contentGate = input.contentGate ?? (
    current && current.sourcePlanVersionId === schedule.planVersionId && current.sourcePlanFingerprint === schedule.planFingerprint
      ? current.contentGate
      : null
  );
  assertPublishable(schedule, channel, input, contentGate);
  const contentHash = publicProjectionContentHash(schedule, channel, contentGate);
  if (current && current.contentHash === contentHash && current.sourcePlanVersionId === schedule.planVersionId && current.audiencePolicyVersion === input.audiencePolicyVersion && current.commitmentWatermark === input.commitmentWatermark) {
    return { release: current, created: false };
  }
  const releaseNumber = (current?.releaseNumber ?? 0) + 1;
  const releaseId = `release:${channel.id}:${releaseNumber}:${contentHash}`;
  const projection = buildPublicEventProjection(schedule, channel, {
    releaseId,
    releaseNumber,
    contentHash,
    publishedAt: input.publishedAt,
    contentGate,
  });
  const release: PublicationRelease = {
    schema: "publication-release/v1",
    id: releaseId,
    workspaceId: input.scope.workspaceId,
    eventId: input.scope.eventId,
    channelId: channel.id,
    releaseNumber,
    audience: channel.audience,
    sourcePlanVersionId: schedule.planVersionId,
    sourcePlanFingerprint: schedule.planFingerprint,
    audiencePolicyVersion: input.audiencePolicyVersion,
    commitmentWatermark: input.commitmentWatermark,
    contentHash,
    contentGate,
    contentGateFingerprint: contentGate?.fingerprint ?? null,
    supersedesReleaseId: current?.id ?? null,
    publishedAt: input.publishedAt,
    sealedAt: input.publishedAt,
    revokedAt: null,
    revocationReason: null,
    idempotencyKey: input.idempotencyKey,
    projection,
  };
  return repository.putSealedRelease({
    scope: input.scope,
    channelId: channel.id,
    expectedCurrentReleaseId: current?.id ?? null,
    release,
  });
}

export function getCurrentPublicProjection(
  repository: PublicationRepository,
  scope: PublicationScope,
  channelIdOrSlug: string,
) {
  const channel = repository.getChannel(scope, channelIdOrSlug);
  if (!channel) return null;
  const release = repository.getCurrentRelease(scope, channel.id);
  if (!release || release.revokedAt) return null;
  return release.projection;
}

export function getReleaseForOrganizer(
  repository: PublicationRepository,
  scope: PublicationScope,
  releaseId: string,
): PublicationRelease | null {
  return repository.getRelease(scope, releaseId);
}

export function previewApprovedSchedule(
  repository: PublicationRepository,
  schedule: ApprovedScheduleSnapshot,
  input: { scope: PublicationScope; channelId: string; audiencePolicyVersion: number; commitmentWatermark: string; contentGate?: ContentPublicationGate | null },
) {
  const channel = repository.getChannel(input.scope, input.channelId);
  if (!channel) throw new PublicationCommandError("PUBLICATION_CHANNEL_NOT_FOUND", "The publication channel is not in the requested scope.");
  return buildPublicationPreview(schedule, channel, {
    audiencePolicyVersion: input.audiencePolicyVersion,
    commitmentWatermark: input.commitmentWatermark,
    contentGate: input.contentGate,
  });
}
