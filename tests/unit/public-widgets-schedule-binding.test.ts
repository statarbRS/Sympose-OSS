import { describe, expect, it } from "vitest";

import { createSyntheticPublicationState } from "@/server/services/public-agenda";
import { bindPublicAgendaRelease, toPublicWidgetProjection } from "@/server/services/public-widgets";
import { publicReleaseReference } from "@/server/services/public-reference";
import {
  SYNTHETIC_PUBLIC_EVENT_ID,
  SYNTHETIC_PUBLIC_WORKSPACE_ID,
} from "@/server/services/scheduling";

describe("schedule publication to public widget binding", () => {
  it("feeds the widget from the same sealed release as the canonical public event", () => {
    const state = createSyntheticPublicationState({
      workspaceId: SYNTHETIC_PUBLIC_WORKSPACE_ID,
      eventId: SYNTHETIC_PUBLIC_EVENT_ID,
    });
    const releaseReference = publicReleaseReference({
      workspaceId: state.currentRelease.workspaceId,
      eventId: state.currentRelease.eventId,
      releaseId: state.currentRelease.id,
    });
    const published = bindPublicAgendaRelease(state.currentRelease, releaseReference);
    const widget = toPublicWidgetProjection(published);

    expect(widget.event.publicReference).toBe(releaseReference);
    expect(widget.release.channelReference).toBe(releaseReference);
    expect(widget.event.title).toBe(state.currentRelease.projection.event.name);
    expect(widget.sessions.map((session) => session.publicReference)).toEqual(
      state.currentRelease.projection.sessions.map((session) => session.slug),
    );
    expect(widget.release.releaseNumber).toBe(state.currentRelease.releaseNumber);
    expect(widget.release.releaseReference).toBe(releaseReference);
    expect(widget.speakers).toHaveLength(5);
    expect(JSON.stringify(widget)).not.toContain("private@example.test");
    expect(JSON.stringify(widget)).not.toContain("Organizer notes");
  });
});
