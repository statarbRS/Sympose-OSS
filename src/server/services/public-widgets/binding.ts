import { validatePublicReleaseForRead } from "../publication";
import type { PublicationRelease } from "../public-agenda/types";
import type { Db } from "../../db";
import { listPublicSpeakerHeadshots } from "../artifact-records";
import {
  isAudienceReference,
  publicPersonReference,
  publicProgramUnitReference,
  publicReleaseReference,
  type AudienceReferenceScope,
} from "../public-reference";
import {
  parsePublishedEventProjection,
  toPublicWidgetProjection,
  type PublishedEventProjection,
  type PublicWidgetProjection,
} from "./contracts";

const RELEASE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function numericCommitmentWatermark(value: string): number {
  const suffix = value.match(/(\d+)$/u)?.[1];
  if (!suffix) return 0;
  const parsed = Number(suffix);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function storedReleaseNumber(db: Db, scope: { readonly workspaceId: string; readonly eventId: string }, releaseId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS releaseNumber
       FROM publication_releases
      WHERE workspace_id = ? AND event_id = ? AND sealed_at IS NOT NULL
        AND (sealed_at < (SELECT sealed_at FROM publication_releases WHERE id = ?)
          OR (sealed_at = (SELECT sealed_at FROM publication_releases WHERE id = ?) AND rowid <= (SELECT rowid FROM publication_releases WHERE id = ?)))`,
  ).get(scope.workspaceId, scope.eventId, releaseId, releaseId, releaseId) as { releaseNumber: number };
  return Number.isSafeInteger(row.releaseNumber) && row.releaseNumber > 0 ? row.releaseNumber : 1;
}

/** Purely transforms an already-authorized release object; it performs no database lookup. */
export function bindPublicAgendaRelease(
  release: PublicationRelease,
  channelReference: string,
): PublishedEventProjection {
  if (release.audience !== "PUBLIC") throw new Error("PUBLIC_WIDGET_AUDIENCE_UNSUPPORTED");
  if (!RELEASE_REFERENCE_PATTERN.test(channelReference)) throw new Error("PUBLIC_WIDGET_CHANNEL_REFERENCE_INVALID");
  const projection = release.projection;
  const referenceScope: AudienceReferenceScope = {
    workspaceId: release.workspaceId,
    eventId: release.eventId,
    releaseId: release.id,
  };
  const sessionReference = (value: string) => isAudienceReference(value)
    ? value
    : publicProgramUnitReference(referenceScope, value);
  const speakerReference = (value: string) => isAudienceReference(value)
    ? value
    : publicPersonReference(referenceScope, value);
  return parsePublishedEventProjection({
    schema: "published-event-projection/v1",
    workspaceId: release.workspaceId,
    eventId: release.eventId,
    releaseId: release.id,
    release: {
      channelReference,
      releaseNumber: release.releaseNumber,
      status: "SEALED",
      audience: "PUBLIC",
      approval: "APPROVED",
      current: true,
      revokedAt: release.revokedAt,
      sealedAt: release.sealedAt,
      fingerprint: release.contentHash,
      sourcePlanVersionId: release.sourcePlanVersionId,
      audiencePolicyVersion: release.audiencePolicyVersion,
      commitmentWatermark: numericCommitmentWatermark(release.commitmentWatermark),
    },
    event: {
      publicReference: publicReleaseReference(referenceScope),
      title: projection.event.name,
      summary: `Published public program for ${projection.event.name}.`,
      timezone: projection.event.timezone,
      startsAt: projection.event.startsAt,
      endsAt: projection.event.endsAt,
    },
    sessions: projection.sessions.map((session) => ({
      publicReference: sessionReference(session.slug),
      title: session.title,
      description: session.abstract,
      room: session.roomName,
      track: session.trackName,
      format: "Session",
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      speakerReferences: session.speakerSlugs.map(speakerReference),
      approval: "APPROVED",
      visibility: "PUBLIC",
    })),
    speakers: projection.speakers.map((speaker) => ({
      publicReference: speakerReference(speaker.slug),
      displayName: speaker.name,
      headline: null,
      organization: speaker.organization || null,
      bio: speaker.bio,
      photoUrl: null,
      sessionReferences: speaker.sessionSlugs.map(sessionReference),
      approval: "APPROVED",
      visibility: "PUBLIC",
    })),
  });
}

function resolveStoredPublicAgendaRelease(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
  channelReference: string,
  releaseId: string | null,
  requireCurrent: boolean,
): PublishedEventProjection | null {
  if (!RELEASE_REFERENCE_PATTERN.test(channelReference)) throw new Error("PUBLIC_WIDGET_CHANNEL_REFERENCE_INVALID");
  const event = db.prepare(
    "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
  ).get(scope.workspaceId, scope.eventId) as { currentReleaseId: string | null } | undefined;
  const targetReleaseId = releaseId ?? event?.currentReleaseId ?? null;
  if (!targetReleaseId) return null;
  const validated = validatePublicReleaseForRead(db, {
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    releaseId: targetReleaseId,
    mode: requireCurrent ? "CURRENT" : "HISTORICAL",
  });
  if (!validated) return null;
  try {
    // Event display fields are sealed in the release. The mutable events row is used only for
    // tenant/event scoping and the current pointer; comparing names or dates here would make
    // historical releases disappear after an organizer edits the event record.
    const content = validated.content;
    const referenceScope: AudienceReferenceScope = {
      workspaceId: validated.workspaceId,
      eventId: validated.eventId,
      releaseId: validated.releaseId,
    };
    if (content.schedule) {
      const acceptedByUnit = new Map<string, typeof content.accepted>();
      const speakers = new Map<string, { name: string; sessions: Set<string> }>();
      for (const accepted of content.accepted) {
        const rows = acceptedByUnit.get(accepted.programUnitId) ?? [];
        rows.push(accepted);
        acceptedByUnit.set(accepted.programUnitId, rows);
        const existingSpeaker = speakers.get(accepted.personId);
        if (existingSpeaker && existingSpeaker.name !== accepted.personName) return null;
        const speaker = existingSpeaker ?? { name: accepted.personName, sessions: new Set<string>() };
        speaker.sessions.add(accepted.programUnitId);
        speakers.set(accepted.personId, speaker);
      }
      const sessions = content.schedule.sessions.map((session) => {
        const accepted = acceptedByUnit.get(session.programUnitId);
        if (!accepted || accepted.length === 0) return null;
        const acceptedPeople = accepted.map((row) => row.personId).sort();
        const scheduledPeople = [...session.speakerPersonIds].sort();
        if (JSON.stringify(acceptedPeople) !== JSON.stringify(scheduledPeople) || accepted.some((row) => row.programUnitName !== session.programUnitName)) return null;
        return {
          publicReference: publicProgramUnitReference(referenceScope, session.programUnitId),
          title: session.title,
          description: session.abstract,
          room: session.placement.roomName,
          track: session.placement.trackName,
          format: "Session",
          startsAt: session.placement.startsAt,
          endsAt: session.placement.endsAt,
          speakerReferences: scheduledPeople.map((personId) => publicPersonReference(referenceScope, personId)),
          approval: "APPROVED" as const,
          visibility: "PUBLIC" as const,
        };
      });
      if (sessions.some((session) => session === null) || sessions.length !== acceptedByUnit.size) return null;
      return parsePublishedEventProjection({
        schema: "published-event-projection/v1",
        workspaceId: validated.workspaceId,
        eventId: validated.eventId,
        releaseId: validated.releaseId,
        release: {
          channelReference,
          releaseNumber: storedReleaseNumber(db, scope, validated.releaseId),
          status: "SEALED",
          audience: "PUBLIC",
          approval: "APPROVED",
          current: validated.current,
          revokedAt: null,
          sealedAt: validated.sealedAt,
          fingerprint: validated.fingerprint,
          sourcePlanVersionId: validated.planVersionId,
          audiencePolicyVersion: validated.audiencePolicyVersion,
          commitmentWatermark: validated.commitmentWatermark,
        },
        event: {
          publicReference: publicReleaseReference(referenceScope),
          title: content.event.name,
          summary: `Published public program for ${content.event.name}.`,
          timezone: content.event.timezone,
          startsAt: content.event.startsAt,
          endsAt: content.event.endsAt,
        },
        sessions: sessions as NonNullable<typeof sessions[number]>[],
        speakers: [...speakers.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([personId, speaker]) => ({
          publicReference: publicPersonReference(referenceScope, personId),
          displayName: speaker.name,
          headline: null,
          organization: null,
          bio: null,
          photoUrl: null,
          sessionReferences: [...speaker.sessions]
            .sort()
            .map((programUnitId) => publicProgramUnitReference(referenceScope, programUnitId)),
          approval: "APPROVED" as const,
          visibility: "PUBLIC" as const,
        })),
      });
    }
    const sessions = new Map<string, { title: string; startsAt: string; endsAt: string; speakers: Set<string> }>();
    const speakers = new Map<string, { name: string; sessions: Set<string> }>();
    for (const accepted of content.accepted) {
      const session = sessions.get(accepted.programUnitId) ?? { title: accepted.programUnitName, startsAt: accepted.startsAt, endsAt: accepted.endsAt, speakers: new Set<string>() };
      if (session.title !== accepted.programUnitName || session.startsAt !== accepted.startsAt || session.endsAt !== accepted.endsAt) return null;
      session.speakers.add(accepted.personId);
      sessions.set(accepted.programUnitId, session);
      const speaker = speakers.get(accepted.personId) ?? { name: accepted.personName, sessions: new Set<string>() };
      if (speaker.name !== accepted.personName) return null;
      speaker.sessions.add(accepted.programUnitId);
      speakers.set(accepted.personId, speaker);
    }
    return parsePublishedEventProjection({
      schema: "published-event-projection/v1",
      workspaceId: validated.workspaceId,
      eventId: validated.eventId,
      releaseId: validated.releaseId,
      release: {
        channelReference,
        releaseNumber: storedReleaseNumber(db, scope, validated.releaseId),
        status: "SEALED",
        audience: "PUBLIC",
        approval: "APPROVED",
        current: validated.current,
        revokedAt: null,
        sealedAt: validated.sealedAt,
        fingerprint: validated.fingerprint,
        sourcePlanVersionId: validated.planVersionId,
        audiencePolicyVersion: validated.audiencePolicyVersion,
        commitmentWatermark: validated.commitmentWatermark,
      },
      event: {
        publicReference: publicReleaseReference(referenceScope),
        title: content.event.name,
        summary: `Published public program for ${content.event.name}.`,
        timezone: content.event.timezone,
        startsAt: content.event.startsAt,
        endsAt: content.event.endsAt,
      },
      sessions: [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([programUnitId, session]) => ({
        publicReference: publicProgramUnitReference(referenceScope, programUnitId),
        title: session.title,
        description: "Published program session.",
        room: null,
        track: null,
        format: "Session",
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        speakerReferences: [...session.speakers]
          .sort()
          .map((personId) => publicPersonReference(referenceScope, personId)),
        approval: "APPROVED",
        visibility: "PUBLIC",
      })),
      speakers: [...speakers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([personId, speaker]) => ({
        publicReference: publicPersonReference(referenceScope, personId),
        displayName: speaker.name,
        headline: null,
        organization: null,
        bio: null,
        photoUrl: null,
        sessionReferences: [...speaker.sessions]
          .sort()
          .map((programUnitId) => publicProgramUnitReference(referenceScope, programUnitId)),
        approval: "APPROVED",
        visibility: "PUBLIC",
      })),
    });
  } catch {
    return null;
  }
}

export function resolveCurrentPublicAgendaRelease(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
  channelReference: string,
): PublishedEventProjection | null {
  const projection = resolveStoredPublicAgendaRelease(db, scope, channelReference, null, true);
  return projection ? bindReleaseBoundSpeakerArtifacts(db, projection, "CURRENT") : null;
}

export interface CurrentPublicWidgetBinding {
  readonly releaseReference: string;
  readonly widget: PublicWidgetProjection;
}

/**
 * Resolve one event's canonical anonymous entry from its validated current sealed release.
 * The opaque release reference is both the route key and the widget channel key; no stable
 * synthetic channel can survive supersession or bridge workspaces.
 */
export function resolveCurrentPublicWidgetBinding(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
): CurrentPublicWidgetBinding | null {
  const event = db.prepare(
    "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
  ).get(scope.workspaceId, scope.eventId) as { currentReleaseId: string | null } | undefined;
  if (!event?.currentReleaseId) return null;

  const release = validatePublicReleaseForRead(db, {
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    releaseId: event.currentReleaseId,
    mode: "CURRENT",
  });
  if (!release) return null;

  const releaseReference = publicReleaseReference({
    workspaceId: release.workspaceId,
    eventId: release.eventId,
    releaseId: release.releaseId,
  });
  const projection = resolveCurrentPublicAgendaRelease(db, scope, releaseReference);
  if (
    !projection ||
    projection.event.publicReference !== releaseReference ||
    projection.release.channelReference !== releaseReference
  ) return null;

  const widget = toPublicWidgetProjection(projection);
  if (
    widget.event.publicReference !== releaseReference ||
    widget.release.channelReference !== releaseReference ||
    widget.release.releaseReference !== releaseReference
  ) return null;

  return Object.freeze({ releaseReference, widget });
}

/** Resolve a public channel reference to exactly one durable current event release. */
export function resolveCurrentPublicAgendaReleaseByChannel(
  db: Db,
  channelReference: string,
): PublishedEventProjection | null {
  if (!isAudienceReference(channelReference)) return null;
  const rows = db.prepare(
    `SELECT e.workspace_id AS workspaceId, e.id AS eventId, release_row.id AS releaseId
       FROM events e
       JOIN publication_releases release_row
         ON release_row.workspace_id = e.workspace_id
        AND release_row.event_id = e.id
        AND release_row.id = e.current_release_id
      WHERE release_row.sealed_at IS NOT NULL`,
  ).all() as unknown as Array<{ workspaceId: string; eventId: string; releaseId: string }>;
  const matches = rows.filter((row) => {
    try {
      return publicReleaseReference(row) === channelReference;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) return null;
  return resolveCurrentPublicAgendaRelease(db, {
    workspaceId: matches[0]!.workspaceId,
    eventId: matches[0]!.eventId,
  }, channelReference);
}

export function resolveExactPublicAgendaRelease(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string; readonly releaseId: string },
  channelReference: string,
): PublishedEventProjection | null {
  const projection = resolveStoredPublicAgendaRelease(db, scope, channelReference, scope.releaseId, false);
  return projection ? bindReleaseBoundSpeakerArtifacts(db, projection, "HISTORICAL") : null;
}

/**
 * A saved public configuration is a current projection, even though it carries an exact release
 * identifier. Reusing the exact historical resolver here would let a newer approved plan leave an
 * older release visible through a durable embed URL.
 */
export function resolveSavedPublicAgendaRelease(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string; readonly releaseId: string },
  channelReference: string,
): PublishedEventProjection | null {
  try {
    if (publicReleaseReference(scope) !== channelReference) return null;
  } catch {
    return null;
  }
  const projection = resolveStoredPublicAgendaRelease(db, scope, channelReference, scope.releaseId, true);
  return projection ? bindReleaseBoundSpeakerArtifacts(db, projection, "CURRENT") : null;
}

function bindReleaseBoundSpeakerArtifacts(
  db: Db,
  projection: PublishedEventProjection,
  mode: "HISTORICAL" | "CURRENT",
): PublishedEventProjection {
  const headshots = listPublicSpeakerHeadshots(db, {
    workspaceId: projection.workspaceId,
    eventId: projection.eventId,
    releaseId: projection.releaseId,
    mode,
  });
  const byPerson = new Map(headshots.map((headshot) => [headshot.personReference, headshot]));
  return parsePublishedEventProjection({
    ...projection,
    speakers: projection.speakers.map((speaker) => {
      const headshot = byPerson.get(speaker.publicReference);
      return { ...speaker, photoUrl: headshot?.publicPath ?? null };
    }),
  });
}
