import { detectScheduleConflicts, deterministicFingerprint } from "../scheduling/deterministic";
import type { ApprovedScheduleSnapshot, ScheduleSnapshot } from "../scheduling/types";
import type {
  ContentKind,
  ContentPayload,
  ContentPublicationGate,
} from "../content-operations";
import {
  isAudienceReference,
  publicPersonReference,
  publicProgramUnitReference,
  publicReleaseReference,
  type AudienceReferenceScope,
} from "../public-reference";
import type { PublicationChannel, PublicationPreview, PublicEventProjection } from "./types";

function publicText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function channelScopeMatches(schedule: ScheduleSnapshot, channel: PublicationChannel): boolean {
  return schedule.workspaceId === channel.workspaceId && schedule.eventId === channel.eventId;
}

function approvedBlockers(schedule: ScheduleSnapshot, channel: PublicationChannel): string[] {
  const blockers: string[] = [];
  if (!channelScopeMatches(schedule, channel)) blockers.push("The channel and approved plan belong to different workspace/event scopes.");
  if (schedule.status !== "APPROVED") blockers.push("The source plan is not approved.");
  if (detectScheduleConflicts(schedule).length > 0) blockers.push("The approved source contains an unresolved speaker or room conflict.");
  if (schedule.sessions.some((session) => session.placement === null && session.public)) blockers.push("A public session is still unscheduled.");
  if (channel.audience !== "PUBLIC") blockers.push("This projection builder only materializes the public audience.");
  return blockers;
}

function requiredContentIds(schedule: ScheduleSnapshot): Array<{ readonly id: string; readonly kind: ContentKind; readonly label: string }> {
  const includedSessions = schedule.sessions.filter((session) => session.public && session.placement !== null);
  const includedSpeakerIds = new Set(includedSessions.flatMap((session) => session.speakerIds));
  const requirements: Array<{ readonly id: string; readonly kind: ContentKind; readonly label: string }> = includedSessions.flatMap((session) => [
    { id: `session:${session.id}:title`, kind: "SESSION_TITLE" as const, label: `Session “${session.title}” title` },
    { id: `session:${session.id}:description`, kind: "SESSION_DESCRIPTION" as const, label: `Session “${session.title}” description` },
  ]);
  for (const speaker of schedule.speakers) {
    if (speaker.public && includedSpeakerIds.has(speaker.id)) {
      requirements.push({ id: `speaker:${speaker.id}:profile`, kind: "PROFILE", label: `Speaker “${speaker.publicName}” profile` });
    }
  }
  return requirements;
}

function contentGateBlockers(schedule: ScheduleSnapshot, gate: ContentPublicationGate | null | undefined): string[] {
  if (!gate) return [];
  const blockers: string[] = [];
  if (gate.workspaceId !== schedule.workspaceId || gate.eventId !== schedule.eventId) {
    blockers.push("The content approval gate belongs to a different workspace/event scope.");
  }
  if (gate.source !== "content-operations-exact-current-version") {
    blockers.push("The content approval gate does not identify the exact content authority.");
  }
  if (gate.state !== "READY") blockers.push(...gate.blockers);
  const factsById = new Map(gate.items.map((item) => [item.requirement.id, item]));
  for (const required of requiredContentIds(schedule)) {
    const fact = factsById.get(required.id);
    if (!fact || fact.requirement.kind !== required.kind || fact.status !== "APPROVED" || !fact.approvedVersionId || !fact.approvedContentHash || fact.currentVersionId !== fact.approvedVersionId || fact.currentContentHash !== fact.approvedContentHash || !fact.approvedPayload) {
      blockers.push(`Required public content “${required.label}” is not bound to an exact approved version.`);
    }
  }
  return [...new Set(blockers)];
}

export function buildPublicationPreview(
  schedule: ScheduleSnapshot,
  channel: PublicationChannel,
  input: { audiencePolicyVersion: number; commitmentWatermark: string; contentGate?: ContentPublicationGate | null },
): PublicationPreview {
  const blockers = approvedBlockers(schedule, channel);
  blockers.push(...contentGateBlockers(schedule, input.contentGate));
  if (!Number.isInteger(input.audiencePolicyVersion) || input.audiencePolicyVersion < 1) blockers.push("An explicit audience-policy version is required.");
  if (typeof input.commitmentWatermark !== "string" || input.commitmentWatermark.trim().length === 0 || input.commitmentWatermark.length > 200) blockers.push("An explicit bounded commitment watermark is required.");
  const includedSessions = schedule.sessions.filter((session) => session.public && session.placement !== null);
  const includedSpeakerIds = new Set(includedSessions.flatMap((session) => session.speakerIds));
  const includedSpeakers = schedule.speakers.filter((speaker) => includedSpeakerIds.has(speaker.id) && speaker.public);
  return {
    state: blockers.length === 0 ? "READY" : "BLOCKED",
    sourcePlanVersionId: schedule.planVersionId,
    sourcePlanFingerprint: schedule.planFingerprint,
    audiencePolicyVersion: input.audiencePolicyVersion,
    commitmentWatermark: input.commitmentWatermark,
    includedSessionCount: includedSessions.length,
    includedSpeakerCount: includedSpeakers.length,
    excludedSessionCount: schedule.sessions.length - includedSessions.length,
    excludedSpeakerCount: includedSpeakerIds.size - includedSpeakers.length,
    blockers,
    redactions: ["Speaker email", "Speaker private notes", "Session organizer notes", "Plan rationale and internal scores"],
    contentGate: input.contentGate ?? null,
  };
}

function exactApprovedPayload<K extends ContentKind>(
  gate: ContentPublicationGate,
  id: string,
  kind: K,
): Extract<ContentPayload, { readonly kind: K }> {
  const item = gate.items.find((candidate) => candidate.requirement.id === id);
  if (!item || item.requirement.kind !== kind || item.status !== "APPROVED" || item.approvedVersionId === null || item.currentVersionId !== item.approvedVersionId || item.currentContentHash !== item.approvedContentHash || item.approvedPayload?.kind !== kind) {
    throw new Error(`PUBLICATION_CONTENT_BINDING_INVALID: ${id} is not bound to an exact approved ${kind} version.`);
  }
  return item.approvedPayload as Extract<ContentPayload, { readonly kind: K }>;
}

export function buildPublicEventProjection(
  schedule: ApprovedScheduleSnapshot,
  channel: PublicationChannel,
  input: {
    releaseId: string;
    releaseNumber: number;
    contentHash: string;
    publishedAt: string;
    contentGate?: ContentPublicationGate | null;
  },
): PublicEventProjection {
  const preview = buildPublicationPreview(schedule, channel, {
    audiencePolicyVersion: 1,
    commitmentWatermark: "projection-only",
    contentGate: input.contentGate,
  });
  if (preview.state !== "READY") {
    throw new Error(`PUBLICATION_NOT_READY: ${preview.blockers.join(" ")}`);
  }
  const dayById = new Map(schedule.days.map((day) => [day.id, day]));
  const trackById = new Map(schedule.tracks.map((track) => [track.id, track]));
  const roomById = new Map(schedule.rooms.map((room) => [room.id, room]));
  const referenceScope: AudienceReferenceScope = {
    workspaceId: schedule.workspaceId,
    eventId: schedule.eventId,
    releaseId: input.releaseId,
  };
  const publicSpeakers = new Map(schedule.speakers.filter((speaker) => speaker.public).map((speaker) => [
    speaker.id,
    { ...speaker, publicReference: publicPersonReference(referenceScope, speaker.id) },
  ]));
  const sessions = schedule.sessions
    .filter((session) => session.public && session.placement !== null)
    .map((session) => {
      const placement = session.placement!;
      const day = dayById.get(placement.dayId);
      const room = roomById.get(placement.roomId);
      const track = trackById.get(placement.trackId);
      if (!day || !room || !track) throw new Error("PUBLICATION_SOURCE_REFERENCE_INVALID: a session references missing schedule metadata.");
      const title = input.contentGate
        ? exactApprovedPayload(input.contentGate, `session:${session.id}:title`, "SESSION_TITLE").title
        : session.title;
      const abstract = input.contentGate
        ? exactApprovedPayload(input.contentGate, `session:${session.id}:description`, "SESSION_DESCRIPTION").description
        : session.abstract;
      return {
        slug: publicProgramUnitReference(referenceScope, session.id),
        title: publicText(title, 180),
        abstract: publicText(abstract, 600),
        dayId: day.id,
        date: day.date,
        startsAt: placement.startsAt,
        endsAt: placement.endsAt,
        roomId: room.id,
        roomName: publicText(room.name, 120),
        venue: publicText(room.venue, 120),
        trackId: track.id,
        trackName: publicText(track.name, 120),
        speakerSlugs: session.speakerIds
          .map((speakerId) => publicSpeakers.get(speakerId)?.publicReference)
          .filter((slug): slug is string => typeof slug === "string")
          .sort(),
      };
    })
    .sort((first, second) => first.startsAt.localeCompare(second.startsAt) || first.roomId.localeCompare(second.roomId) || first.slug.localeCompare(second.slug));
  const sessionSlugsBySpeaker = new Map<string, string[]>();
  for (const session of sessions) {
    for (const speaker of session.speakerSlugs) {
      const existing = sessionSlugsBySpeaker.get(speaker) ?? [];
      existing.push(session.slug);
      sessionSlugsBySpeaker.set(speaker, existing);
    }
  }
  const speakers = [...publicSpeakers.values()]
    .filter((speaker) => sessionSlugsBySpeaker.has(speaker.publicReference))
    .map((speaker) => {
      const profile = input.contentGate
        ? exactApprovedPayload(input.contentGate, `speaker:${speaker.id}:profile`, "PROFILE")
        : null;
      return {
        slug: speaker.publicReference,
        name: publicText(profile?.publicTitle ?? speaker.publicName, 120),
        organization: publicText(profile?.organization ?? speaker.organization, 160),
        bio: publicText(profile?.bio ?? speaker.bio, 600),
        sessionSlugs: [...(sessionSlugsBySpeaker.get(speaker.publicReference) ?? [])].sort(),
      };
    })
    .sort((first, second) => first.name.localeCompare(second.name));
  const content = {
    schema: "public-event/v1" as const,
    event: {
      slug: publicReleaseReference(referenceScope),
      name: publicText(schedule.event.name, 180),
      timezone: publicText(schedule.event.timezone, 80),
      startsAt: schedule.event.startsAt,
      endsAt: schedule.event.endsAt,
    },
    days: schedule.days.map((day) => ({ id: day.id, date: day.date, label: publicText(day.label, 120) })),
    tracks: schedule.tracks.map((track) => ({ id: track.id, name: publicText(track.name, 120) })),
    rooms: schedule.rooms.map((room) => ({ id: room.id, name: publicText(room.name, 120), venue: publicText(room.venue, 120) })),
    sessions,
    speakers,
    redaction: {
      excludedSessionCount: schedule.sessions.length - sessions.length,
      excludedSpeakerCount: schedule.speakers.length - speakers.length,
      omittedFields: ["Speaker email", "Speaker private notes", "Session organizer notes", "Plan rationale and internal scores"],
    },
  };
  return {
    ...content,
    release: {
      releaseId: input.releaseId,
      releaseNumber: input.releaseNumber,
      contentHash: input.contentHash,
      publishedAt: input.publishedAt,
      audience: "PUBLIC",
    },
  };
}

export function publicProjectionContentHash(
  schedule: ApprovedScheduleSnapshot,
  channel: PublicationChannel,
  contentGate?: ContentPublicationGate | null,
): string {
  const placeholder = buildPublicEventProjection(schedule, channel, {
    releaseId: "sealed-release-placeholder",
    releaseNumber: 0,
    contentHash: "content-hash-placeholder",
    publishedAt: "1970-01-01T00:00:00.000Z",
    contentGate,
  });
  return deterministicFingerprint({
    schema: placeholder.schema,
    event: placeholder.event,
    days: placeholder.days,
    tracks: placeholder.tracks,
    rooms: placeholder.rooms,
    sessions: placeholder.sessions,
    speakers: placeholder.speakers,
    redaction: placeholder.redaction,
    contentGateFingerprint: contentGate?.fingerprint ?? null,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && !/[\u0000-\u001F\u007F]/.test(value);
}

function validIsoString(value: unknown, maxLength: number): value is string {
  return validBoundedString(value, maxLength) && Number.isFinite(Date.parse(value));
}

function validStringArray(value: unknown, maxLength: number, itemLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxLength && value.every((item) => validBoundedString(item, itemLength));
}

function validAudienceReferenceArray(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxLength && value.every((item) => isAudienceReference(item));
}

function containsForbiddenPublicKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenPublicKey(entry, depth + 1));
  const forbidden = new Set(["workspaceId", "eventId", "email", "privateNotes", "internalNotes", "internalScore", "planFingerprint", "rationale"]);
  const record = value as Record<string, unknown>;
  return Object.entries(record).some(([key, child]) => forbidden.has(key) || containsForbiddenPublicKey(child, depth + 1));
}

export function isPublicEventProjection(value: unknown): value is PublicEventProjection {
  if (!isRecord(value) || value.schema !== "public-event/v1" || !isRecord(value.event) || !isRecord(value.release)) return false;
  if (containsForbiddenPublicKey(value)) return false;
  if (!isAudienceReference(value.event.slug) || !validBoundedString(value.event.name, 180) || !validBoundedString(value.event.timezone, 80) || !validIsoString(value.event.startsAt, 40) || !validIsoString(value.event.endsAt, 40)) return false;
  if (!validBoundedString(value.release.releaseId, 200) || typeof value.release.releaseNumber !== "number" || !Number.isInteger(value.release.releaseNumber) || value.release.releaseNumber < 1 || !validBoundedString(value.release.contentHash, 200) || !validIsoString(value.release.publishedAt, 40) || value.release.audience !== "PUBLIC") return false;
  if (!Array.isArray(value.days) || value.days.length > 20 || value.days.some((day) => !isRecord(day) || !validBoundedString(day.id, 100) || !validBoundedString(day.date, 40) || !validBoundedString(day.label, 120))) return false;
  if (!Array.isArray(value.tracks) || value.tracks.length > 50 || value.tracks.some((track) => !isRecord(track) || !validBoundedString(track.id, 100) || !validBoundedString(track.name, 120))) return false;
  if (!Array.isArray(value.rooms) || value.rooms.length > 100 || value.rooms.some((room) => !isRecord(room) || !validBoundedString(room.id, 100) || !validBoundedString(room.name, 120) || !validBoundedString(room.venue, 120))) return false;
  if (!Array.isArray(value.sessions) || value.sessions.length > 500 || value.sessions.some((session) => !isRecord(session) || !isAudienceReference(session.slug) || !validBoundedString(session.title, 180) || !validBoundedString(session.abstract, 600) || !validBoundedString(session.dayId, 100) || !validBoundedString(session.date, 40) || !validIsoString(session.startsAt, 40) || !validIsoString(session.endsAt, 40) || !validBoundedString(session.roomId, 100) || !validBoundedString(session.roomName, 120) || !validBoundedString(session.venue, 120) || !validBoundedString(session.trackId, 100) || !validBoundedString(session.trackName, 120) || !validAudienceReferenceArray(session.speakerSlugs, 20))) return false;
  if (!Array.isArray(value.speakers) || value.speakers.length > 500 || value.speakers.some((speaker) => !isRecord(speaker) || !isAudienceReference(speaker.slug) || !validBoundedString(speaker.name, 120) || !validBoundedString(speaker.organization, 160) || !validBoundedString(speaker.bio, 600) || !validAudienceReferenceArray(speaker.sessionSlugs, 100))) return false;
  if (!isRecord(value.redaction) || !Number.isInteger(value.redaction.excludedSessionCount) || !Number.isInteger(value.redaction.excludedSpeakerCount) || !validStringArray(value.redaction.omittedFields, 20, 160)) return false;
  return true;
}

export function parseStoredPublicProjection(raw: string, eventSlug: string): PublicEventProjection | null {
  if (raw.length > 300_000) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPublicEventProjection(parsed) || parsed.event.slug !== eventSlug) return null;
    return JSON.parse(JSON.stringify(parsed)) as PublicEventProjection;
  } catch {
    return null;
  }
}

export function getPublicSession(projection: PublicEventProjection, sessionSlug: string) {
  return projection.sessions.find((session) => session.slug === sessionSlug) ?? null;
}

export function getPublicSpeaker(projection: PublicEventProjection, speakerSlug: string) {
  return projection.speakers.find((speaker) => speaker.slug === speakerSlug) ?? null;
}
