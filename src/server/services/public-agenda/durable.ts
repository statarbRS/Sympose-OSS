import type { Db } from "../../db";
import { validatePublicReleaseForRead, type ValidatedPublicRelease } from "../publication";
import {
  isAudienceReference,
  publicPersonReference,
  publicProgramUnitReference,
  publicReleaseReference,
  type AudienceReferenceScope,
} from "../public-reference";
import type { DurablePublicEventProjection } from "./types";

type DurableAcceptedRow = ValidatedPublicRelease["content"]["accepted"][number];

function datePart(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function buildRichDurableProjection(
  validated: ValidatedPublicRelease,
): DurablePublicEventProjection | null {
  const content = validated.content;
  const schedule = content.schedule;
  if (!schedule) return null;
  const referenceScope: AudienceReferenceScope = {
    workspaceId: validated.workspaceId,
    eventId: validated.eventId,
    releaseId: validated.releaseId,
  };
  const acceptedByUnit = new Map<string, DurableAcceptedRow[]>();
  const speakers = new Map<string, {
    readonly name: string;
    readonly sessions: Set<string>;
    readonly roles: Set<string>;
  }>();
  for (const accepted of content.accepted as DurableAcceptedRow[]) {
    const rows = acceptedByUnit.get(accepted.programUnitId) ?? [];
    rows.push(accepted);
    acceptedByUnit.set(accepted.programUnitId, rows);
    const existing = speakers.get(accepted.personId);
    if (existing && existing.name !== accepted.personName) return null;
    const speaker = existing ?? { name: accepted.personName, sessions: new Set<string>(), roles: new Set<string>() };
    speaker.sessions.add(accepted.programUnitId);
    speaker.roles.add(accepted.role);
    speakers.set(accepted.personId, speaker);
  }
  const sessions = schedule.sessions.map((session) => {
    const accepted = acceptedByUnit.get(session.programUnitId);
    if (!accepted || accepted.length === 0) return null;
    const acceptedPeople = accepted.map((row) => row.personId).sort();
    const scheduledPeople = [...session.speakerPersonIds].sort();
    if (JSON.stringify(acceptedPeople) !== JSON.stringify(scheduledPeople)) return null;
    if (accepted.some((row) => row.programUnitName !== session.programUnitName)) return null;
    return {
      slug: publicProgramUnitReference(referenceScope, session.programUnitId),
      title: session.title,
      abstract: session.abstract,
      date: datePart(session.placement.startsAt),
      startsAt: session.placement.startsAt,
      endsAt: session.placement.endsAt,
      roomName: session.placement.roomName,
      venue: session.placement.venue,
      trackName: session.placement.trackName,
      speakerSlugs: scheduledPeople.map((personId) => publicPersonReference(referenceScope, personId)),
    };
  });
  if (sessions.some((session) => session === null) || sessions.length !== acceptedByUnit.size) return null;
  const dayDates = new Set<string>([
    datePart(content.event.startsAt),
    ...sessions.map((session) => session!.date),
  ]);
  return {
    schema: "public-event/durable-publication-release-v2",
    event: {
      slug: publicReleaseReference(referenceScope),
      name: content.event.name,
      timezone: content.event.timezone,
      startsAt: content.event.startsAt,
      endsAt: content.event.endsAt,
    },
    release: {
      releaseReference: publicReleaseReference(referenceScope),
      sealedAt: validated.sealedAt,
      audience: "PUBLIC",
    },
    days: [...dayDates].sort().map((date) => ({ id: date, date, label: date })),
    sessions: sessions as NonNullable<typeof sessions[number]>[],
    speakers: [...speakers.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([personId, speaker]) => ({
      slug: publicPersonReference(referenceScope, personId),
      name: speaker.name,
      sessionSlugs: [...speaker.sessions]
        .sort()
        .map((programUnitId) => publicProgramUnitReference(referenceScope, programUnitId)),
      roles: [...speaker.roles].sort(),
    })),
    redaction: {
      omittedFields: [
        "Email addresses",
        "Speaker organization and biography",
        "Plan rationale and internal scores",
      ],
    },
  };
}

function buildDurableProjection(
  validated: ValidatedPublicRelease,
): DurablePublicEventProjection | null {
  const content = validated.content;
  if (content.schedule) return buildRichDurableProjection(validated);
  const referenceScope: AudienceReferenceScope = {
    workspaceId: validated.workspaceId,
    eventId: validated.eventId,
    releaseId: validated.releaseId,
  };
  const sessions = new Map<string, {
    readonly title: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly speakers: Set<string>;
  }>();
  const speakers = new Map<string, {
    readonly name: string;
    readonly sessions: Set<string>;
    readonly roles: Set<string>;
  }>();

  for (const accepted of content.accepted as DurableAcceptedRow[]) {
    const existingSession = sessions.get(accepted.programUnitId);
    if (existingSession && (
      existingSession.title !== accepted.programUnitName ||
      existingSession.startsAt !== accepted.startsAt ||
      existingSession.endsAt !== accepted.endsAt
    )) {
      return null;
    }
    const session = existingSession ?? {
      title: accepted.programUnitName,
      startsAt: accepted.startsAt,
      endsAt: accepted.endsAt,
      speakers: new Set<string>(),
    };
    session.speakers.add(accepted.personId);
    sessions.set(accepted.programUnitId, session);

    const existingSpeaker = speakers.get(accepted.personId);
    if (existingSpeaker && existingSpeaker.name !== accepted.personName) return null;
    const speaker = existingSpeaker ?? {
      name: accepted.personName,
      sessions: new Set<string>(),
      roles: new Set<string>(),
    };
    speaker.sessions.add(accepted.programUnitId);
    speaker.roles.add(accepted.role);
    speakers.set(accepted.personId, speaker);
  }

  const dayDates = new Set<string>([
    datePart(content.event.startsAt),
    ...content.accepted.map((accepted) => datePart(accepted.startsAt)),
  ]);
  const days = [...dayDates].sort().map((date) => ({
    id: date,
    date,
    label: date,
  }));
  const publicSessions = [...sessions.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([programUnitId, session]) => ({
      slug: publicProgramUnitReference(referenceScope, programUnitId),
      title: session.title,
      date: datePart(session.startsAt),
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      speakerSlugs: [...session.speakers]
        .sort()
        .map((personId) => publicPersonReference(referenceScope, personId)),
    }));
  const publicSpeakers = [...speakers.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([personId, speaker]) => ({
      slug: publicPersonReference(referenceScope, personId),
      name: speaker.name,
      sessionSlugs: [...speaker.sessions]
        .sort()
        .map((programUnitId) => publicProgramUnitReference(referenceScope, programUnitId)),
      roles: [...speaker.roles].sort(),
    }));

  return {
    schema: "public-event/durable-publication-release-v2",
    event: {
      // v2 has no mutable event slug. This audience reference is bound to the sealed release.
      slug: publicReleaseReference(referenceScope),
      name: content.event.name,
      timezone: content.event.timezone,
      startsAt: content.event.startsAt,
      endsAt: content.event.endsAt,
    },
    release: {
      releaseReference: publicReleaseReference(referenceScope),
      sealedAt: validated.sealedAt,
      audience: "PUBLIC",
    },
    days,
    sessions: publicSessions,
    speakers: publicSpeakers,
    redaction: {
      omittedFields: [
        "Email addresses",
        "Room and venue",
        "Track and format",
        "Session abstract",
        "Speaker organization and biography",
        "Plan rationale and internal scores",
      ],
    },
  };
}

/**
 * Resolve only one durable sealed release that is still the event's current pointer.
 * The URL carries only a dedicated audience reference. Stale, unknown, malformed,
 * cross-release, and ambiguous references fail closed.
 */
export function resolveCurrentDurablePublicAgenda(
  db: Db,
  releaseReference: string,
): DurablePublicEventProjection | null {
  if (!isAudienceReference(releaseReference)) return null;
  const rows = db.prepare(
    `SELECT r.workspace_id AS workspaceId, r.event_id AS eventId, r.id AS releaseId
       FROM publication_releases r
       JOIN events e
        ON e.workspace_id = r.workspace_id
        AND e.id = r.event_id
        AND e.current_release_id = r.id
      WHERE r.sealed_at IS NOT NULL`,
  ).all() as Array<{
    readonly workspaceId: string;
    readonly eventId: string;
    readonly releaseId: string;
  }>;
  const matches = rows.filter((row) => {
    try {
      return publicReleaseReference(row) === releaseReference;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) return null;
  const row = matches[0]!;
  const validated = validatePublicReleaseForRead(db, {
    workspaceId: row.workspaceId,
    eventId: row.eventId,
    releaseId: row.releaseId,
    mode: "CURRENT",
  });
  if (!validated || publicReleaseReference({
    workspaceId: validated.workspaceId,
    eventId: validated.eventId,
    releaseId: validated.releaseId,
  }) !== releaseReference) return null;
  return buildDurableProjection(validated);
}

export function getDurablePublicSession(
  projection: DurablePublicEventProjection,
  sessionSlug: string,
) {
  return projection.sessions.find((session) => session.slug === sessionSlug) ?? null;
}

export function getDurablePublicSpeaker(
  projection: DurablePublicEventProjection,
  speakerSlug: string,
) {
  return projection.speakers.find((speaker) => speaker.slug === speakerSlug) ?? null;
}
