import type { PublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import { listPublicAgendaDays } from "@/server/services/public-widgets/queries";

export interface PublicEmbedManagerViewModel {
  readonly release: {
    readonly channelReference: string;
    readonly releaseNumber: number;
  };
}

export interface PublicItineraryViewModel {
  readonly release: {
    readonly channelReference: string;
    readonly releaseReference: string;
  };
  readonly event: {
    readonly timezone: string;
  };
  readonly days: readonly {
    readonly date: string;
    readonly label: string;
    readonly sessions: readonly {
      readonly publicReference: string;
      readonly title: string;
      readonly description: string;
      readonly room: string | null;
      readonly track: string | null;
      readonly format: string;
      readonly startsAt: string;
      readonly endsAt: string;
      readonly speakerReferences: readonly string[];
      readonly speakers: readonly {
        readonly publicReference: string;
        readonly displayName: string;
      }[];
    }[];
  }[];
}

/** Keep the anonymous embed configurator client payload free of release internals. */
export function toPublicEmbedManagerViewModel(
  widget: PublicWidgetProjection,
): PublicEmbedManagerViewModel {
  return {
    release: {
      channelReference: widget.release.channelReference,
      releaseNumber: widget.release.releaseNumber,
    },
  };
}

/** Keep the browser-local itinerary client payload to public schedule fields only. */
export function toPublicItineraryViewModel(
  widget: PublicWidgetProjection,
): PublicItineraryViewModel {
  return {
    release: {
      channelReference: widget.release.channelReference,
      releaseReference: widget.release.releaseReference,
    },
    event: { timezone: widget.event.timezone },
    days: listPublicAgendaDays(widget).map((day) => ({
      date: day.date,
      label: day.label,
      sessions: day.sessions.map((session) => ({
        publicReference: session.publicReference,
        title: session.title,
        description: session.description,
        room: session.room,
        track: session.track,
        format: session.format,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        speakerReferences: [...session.speakerReferences],
        speakers: session.speakers.map((speaker) => ({
          publicReference: speaker.publicReference,
          displayName: speaker.displayName,
        })),
      })),
    })),
  };
}
