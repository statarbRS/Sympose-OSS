import { describe, expect, it } from "vitest";

import { createSyntheticPublicationState } from "@/server/services/public-agenda";
import { EVALUATOR_ARTIFACT_EVENT_ID, EVALUATOR_ARTIFACT_WORKSPACE_ID } from "@/server/services/evaluator-speaker-identity";
import * as publicWidgets from "@/server/services/public-widgets";
import { bindPublicAgendaRelease, toPublicWidgetProjection } from "@/server/services/public-widgets";
import { publicPersonReference } from "@/server/services/public-reference";

describe("durable public artifact traversal", () => {
  it("does not let copied Mina release metadata attach Mina's photo to an Alex projection", () => {
    const release = createSyntheticPublicationState({
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    }).currentRelease;
    const alexRelease = {
      ...release,
      projection: {
        ...release.projection,
        speakers: release.projection.speakers.map((speaker, index) => index === 0
          ? { ...speaker, slug: "alex-rivera", name: "Alex Rivera" }
          : speaker),
      },
    };
    const widget = toPublicWidgetProjection(bindPublicAgendaRelease(alexRelease, "evaluator-public"));
    const alexReference = publicPersonReference({
      workspaceId: release.workspaceId,
      eventId: release.eventId,
      releaseId: release.id,
    }, "alex-rivera");

    expect(widget.speakers[0]).toMatchObject({ publicReference: alexReference, displayName: "Alex Rivera", photoUrl: null });
    expect("bindPublicAgendaReleaseWithSpeakerArtifacts" in publicWidgets).toBe(false);
    expect("speakerPersonIds" in publicWidgets).toBe(false);
  });

  it("keeps synthetic projections free of durable artifacts and private fields", () => {
    const release = createSyntheticPublicationState({
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    }).currentRelease;
    const widget = toPublicWidgetProjection(bindPublicAgendaRelease(release, "evaluator-public"));

    expect(widget.speakers.find((speaker) => speaker.displayName === "Mina Park")?.photoUrl).toBeNull();
    expect(JSON.stringify(widget)).not.toContain("SLIDES");
    expect(JSON.stringify(widget)).not.toContain("privateNotes");
  });
});
