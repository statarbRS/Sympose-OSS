import {
  createSyntheticApprovedScheduleProjection,
  SYNTHETIC_PUBLIC_CHANNEL_ID,
  SYNTHETIC_PUBLIC_EVENT_ID,
  SYNTHETIC_PUBLIC_EVENT_SLUG,
  SYNTHETIC_PUBLIC_WORKSPACE_ID,
} from "../scheduling/synthetic";
import { deterministicUuid } from "../../canonical";
import {
  EVALUATOR_ARTIFACT_EVENT_ID,
  EVALUATOR_ARTIFACT_PERSON_ID,
  EVALUATOR_ARTIFACT_WORKSPACE_ID,
} from "../evaluator-speaker-identity";
import {
  createSyntheticContentOperationsRepository,
  evaluateContentPublicationGate,
  type ContentOperationsRepository,
  type ContentOperationsScope,
  type ContentPayload,
  type ContentPublicationRequirement,
} from "../content-operations";
import { publishApprovedSchedule } from "./publication";
import { InMemoryPublicationRepository } from "./repository";
import type { PublicationChannel, SyntheticPublicationState } from "./types";
import type { ApprovedScheduleSnapshot } from "../scheduling/types";

const SYNTHETIC_CONTENT_ACTOR_ID = deterministicUuid("synthetic-publication-content:organizer");

function evaluatorPublicScheduleAdapter(
  schedule: ApprovedScheduleSnapshot,
): ApprovedScheduleSnapshot {
  if (schedule.workspaceId !== EVALUATOR_ARTIFACT_WORKSPACE_ID || schedule.eventId !== EVALUATOR_ARTIFACT_EVENT_ID) {
    return schedule;
  }
  return {
    ...schedule,
    speakers: [
      ...schedule.speakers,
      {
        id: EVALUATOR_ARTIFACT_PERSON_ID,
        slug: "mina-park",
        displayName: "Mina Park",
        publicName: "Mina Park",
        organization: "Signal Garden",
        bio: "Builds trustworthy evaluation systems for public-interest technology.",
        email: "mina.private@example.test",
        privateNotes: "Evaluator-only speaker fixture.",
        public: true,
      },
    ],
    sessions: schedule.sessions.map((session) => session.id === "session-trust"
      ? { ...session, speakerIds: [...session.speakerIds, EVALUATOR_ARTIFACT_PERSON_ID] }
      : session),
  };
}

export function createSyntheticPublicationContentRequirements(
  schedule: ApprovedScheduleSnapshot,
): readonly ContentPublicationRequirement[] {
  const requirements: ContentPublicationRequirement[] = [];
  for (const session of schedule.sessions.filter((candidate) => candidate.public)) {
    requirements.push(
      {
        id: `session:${session.id}:title`,
        label: `Session “${session.title}” title`,
        personId: `session-owner:${session.id}`,
        taskId: `publication-content:${session.id}:title`,
        kind: "SESSION_TITLE",
        required: true,
      },
      {
        id: `session:${session.id}:description`,
        label: `Session “${session.title}” description`,
        personId: `session-owner:${session.id}`,
        taskId: `publication-content:${session.id}:description`,
        kind: "SESSION_DESCRIPTION",
        required: true,
      },
    );
  }
  const publicSpeakerIds = new Set(schedule.sessions.filter((session) => session.public).flatMap((session) => session.speakerIds));
  for (const speaker of schedule.speakers.filter((candidate) => candidate.public && publicSpeakerIds.has(candidate.id))) {
    requirements.push({
      id: `speaker:${speaker.id}:profile`,
      label: `Speaker “${speaker.publicName}” profile`,
      personId: speaker.id,
      taskId: `publication-content:${speaker.id}:profile`,
      kind: "PROFILE",
      required: true,
    });
  }
  return Object.freeze(requirements.map((requirement) => Object.freeze({ ...requirement })));
}

function syntheticContentScope(schedule: ApprovedScheduleSnapshot): ContentOperationsScope {
  return {
    workspaceId: schedule.workspaceId,
    eventId: schedule.eventId,
    actorId: SYNTHETIC_CONTENT_ACTOR_ID,
    actorKind: "organizer",
  };
}

function contentPayloadForRequirement(
  schedule: ApprovedScheduleSnapshot,
  requirement: ContentPublicationRequirement,
): ContentPayload {
  if (requirement.kind === "SESSION_TITLE") {
    const session = schedule.sessions.find((candidate) => `session:${candidate.id}:title` === requirement.id);
    if (!session) throw new Error(`SYNTHETIC_CONTENT_SOURCE_MISSING: ${requirement.id}`);
    return { kind: "SESSION_TITLE", title: session.title };
  }
  if (requirement.kind === "SESSION_DESCRIPTION") {
    const session = schedule.sessions.find((candidate) => `session:${candidate.id}:description` === requirement.id);
    if (!session) throw new Error(`SYNTHETIC_CONTENT_SOURCE_MISSING: ${requirement.id}`);
    return { kind: "SESSION_DESCRIPTION", description: session.abstract };
  }
  const speaker = schedule.speakers.find((candidate) => candidate.id === requirement.personId);
  if (!speaker || requirement.kind !== "PROFILE") throw new Error(`SYNTHETIC_CONTENT_SOURCE_MISSING: ${requirement.id}`);
  return {
    kind: "PROFILE",
    bio: speaker.bio,
    publicTitle: speaker.publicName,
    organization: speaker.organization,
    socialLinks: [],
    headshot: null,
  };
}

export interface SyntheticPublicationContentAuthority {
  readonly repository: ContentOperationsRepository;
  readonly requirements: readonly ContentPublicationRequirement[];
  readonly gate: ReturnType<typeof evaluateContentPublicationGate>;
}

export function createSyntheticPublicationContentAuthority(
  schedule: ApprovedScheduleSnapshot,
  options: { readonly repository?: ContentOperationsRepository; readonly seed?: boolean } = {},
): SyntheticPublicationContentAuthority {
  const repository = options.repository ?? createSyntheticContentOperationsRepository();
  const requirements = createSyntheticPublicationContentRequirements(schedule);
  const shouldSeed = options.seed ?? options.repository === undefined;
  if (shouldSeed) {
    const scope = syntheticContentScope(schedule);
    for (const requirement of requirements) {
      const version = repository.submitVersion(scope, {
        personId: requirement.personId,
        taskId: requirement.taskId,
        payload: contentPayloadForRequirement(schedule, requirement),
        idempotencyKey: `seed-publication-content:${requirement.id}`,
      });
      repository.approveVersion(scope, {
        personId: requirement.personId,
        taskId: requirement.taskId,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: `seed-publication-approval:${requirement.id}`,
      });
    }
  }
  return { repository, requirements, gate: evaluateContentPublicationGate(repository, syntheticContentScope(schedule), requirements) };
}

export function createSyntheticPublicationState(
  scope: { workspaceId: string; eventId: string } = { workspaceId: SYNTHETIC_PUBLIC_WORKSPACE_ID, eventId: SYNTHETIC_PUBLIC_EVENT_ID },
  options: { eventName?: string; eventSlug?: string } = {},
): SyntheticPublicationState {
  const channel: PublicationChannel = {
    id: SYNTHETIC_PUBLIC_CHANNEL_ID,
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    slug: "public-agenda",
    audience: "PUBLIC",
    publicationType: "AGENDA",
    currentReleaseId: null,
    createdAt: "2026-08-12T08:00:00.000Z",
  };
  const repository = new InMemoryPublicationRepository([channel]);
  const approvedSchedule = evaluatorPublicScheduleAdapter(createSyntheticApprovedScheduleProjection(scope, {
    eventName: options.eventName,
    eventSlug: options.eventSlug ?? SYNTHETIC_PUBLIC_EVENT_SLUG,
  }));
  const content = createSyntheticPublicationContentAuthority(approvedSchedule);
  const result = publishApprovedSchedule(repository, approvedSchedule, {
    scope,
    channelId: channel.id,
    audiencePolicyVersion: 1,
    commitmentWatermark: "synthetic-commitment-watermark-v1",
    publishedAt: "2026-08-12T09:00:00.000Z",
    idempotencyKey: "synthetic-initial-publication",
    contentGate: content.gate,
  });
  return {
    repository,
    approvedSchedule,
    currentRelease: result.release,
    contentRepository: content.repository,
    contentRequirements: content.requirements,
    contentGate: content.gate,
  };
}

export function getSyntheticPublicEventProjection(eventSlug: string) {
  if (eventSlug !== SYNTHETIC_PUBLIC_EVENT_SLUG) return null;
  return createSyntheticPublicationState().currentRelease.projection;
}
