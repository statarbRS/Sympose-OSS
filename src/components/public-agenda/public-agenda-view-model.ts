import type {
  DurablePublicEventProjection,
  PublicAgendaProjection,
  PublicEventProjection,
} from "@/server/services/public-agenda/types";

export interface PublicAgendaViewModel {
  readonly kind: "durable" | "published";
  readonly event: {
    readonly name: string;
    readonly timezone: string;
    readonly startsAt: string;
    readonly endsAt: string;
  };
  readonly release: {
    readonly releasedAt: string;
    /** Opaque audience reference for the exact sealed release; never an internal release ID. */
    readonly releaseReference: string | null;
  };
  readonly days: readonly {
    readonly id: string;
    readonly date: string;
    readonly label: string;
  }[];
  readonly tracks: readonly {
    readonly id: string;
    readonly name: string;
  }[];
  readonly sessions: readonly PublicAgendaSession[];
  readonly speakers: readonly PublicAgendaSpeaker[];
  readonly redaction: {
    readonly omittedFields: readonly string[];
  };
}

const AUDIENCE_REFERENCE_PATTERN = /^aud1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validatedReleaseReference(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!AUDIENCE_REFERENCE_PATTERN.test(value)) {
    throw new Error("Public agenda release reference is not a valid audience reference.");
  }
  return value;
}

export interface PublicAgendaSession {
  readonly slug: string;
  readonly title: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly speakerSlugs: readonly string[];
  readonly abstract?: string;
  readonly roomName?: string;
  readonly venue?: string;
  readonly trackId?: string;
  readonly trackName?: string;
}

export interface PublicAgendaSpeaker {
  readonly slug: string;
  readonly name: string;
  readonly sessionSlugs: readonly string[];
  readonly roles?: readonly string[];
  readonly organization?: string;
  readonly bio?: string;
}

function allowlistPublishedSession(
  session: PublicEventProjection["sessions"][number],
): PublicAgendaSession {
  return {
    slug: session.slug,
    title: session.title,
    date: session.date,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    speakerSlugs: [...session.speakerSlugs],
    abstract: session.abstract,
    roomName: session.roomName,
    venue: session.venue,
    trackId: session.trackId,
    trackName: session.trackName,
  };
}

function allowlistDurableSession(
  session: DurablePublicEventProjection["sessions"][number],
): PublicAgendaSession {
  return {
    slug: session.slug,
    title: session.title,
    date: session.date,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    speakerSlugs: [...session.speakerSlugs],
    abstract: session.abstract,
    roomName: session.roomName ?? undefined,
    venue: session.venue ?? undefined,
    trackName: session.trackName ?? undefined,
  };
}

function allowlistPublishedSpeaker(
  speaker: PublicEventProjection["speakers"][number],
): PublicAgendaSpeaker {
  return {
    slug: speaker.slug,
    name: speaker.name,
    sessionSlugs: [...speaker.sessionSlugs],
    organization: speaker.organization,
    bio: speaker.bio,
  };
}

function allowlistDurableSpeaker(
  speaker: DurablePublicEventProjection["speakers"][number],
): PublicAgendaSpeaker {
  return {
    slug: speaker.slug,
    name: speaker.name,
    sessionSlugs: [...speaker.sessionSlugs],
    roles: [...speaker.roles],
  };
}

/**
 * Copy only attendee-safe fields across the server/client boundary. Release IDs,
 * fingerprints, schemas, and organizer lineage stay server-side; the already-derived
 * audience references are the only identifiers copied for public navigation.
 */
export function toPublicAgendaViewModel(
  projection: PublicAgendaProjection,
  releaseReference?: string | null,
): PublicAgendaViewModel {
  if (projection.schema === "public-event/durable-publication-release-v2") {
    const canonicalReleaseReference = validatedReleaseReference(projection.release.releaseReference);
    if (projection.event.slug !== canonicalReleaseReference) {
      throw new Error("Public agenda event and release references do not match.");
    }
    return {
      kind: "durable",
      event: {
        name: projection.event.name,
        timezone: projection.event.timezone,
        startsAt: projection.event.startsAt,
        endsAt: projection.event.endsAt,
      },
      release: {
        releasedAt: projection.release.sealedAt,
        releaseReference: canonicalReleaseReference,
      },
      days: projection.days.map((day) => ({
        id: day.id,
        date: day.date,
        label: day.label,
      })),
      tracks: [],
      sessions: projection.sessions.map(allowlistDurableSession),
      speakers: projection.speakers.map(allowlistDurableSpeaker),
      redaction: { omittedFields: [...projection.redaction.omittedFields] },
    };
  }

  if (projection.schema !== "public-event/v1") {
    throw new Error("Unsupported public agenda projection.");
  }

  return {
    kind: "published",
    event: {
      name: projection.event.name,
      timezone: projection.event.timezone,
      startsAt: projection.event.startsAt,
      endsAt: projection.event.endsAt,
    },
    release: {
      releasedAt: projection.release.publishedAt,
      releaseReference: validatedReleaseReference(releaseReference),
    },
    days: projection.days.map((day) => ({
      id: day.id,
      date: day.date,
      label: day.label,
    })),
    tracks: projection.tracks.map((track) => ({
      id: track.id,
      name: track.name,
    })),
    sessions: projection.sessions.map(allowlistPublishedSession),
    speakers: projection.speakers.map(allowlistPublishedSpeaker),
    redaction: { omittedFields: [...projection.redaction.omittedFields] },
  };
}
