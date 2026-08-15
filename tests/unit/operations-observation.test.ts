import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OperationsObservation } from "@/components/operations-observation/operations-observation";
import type { OperationsObservationSurface } from "@/server/services/outcomes";

const noOpAction = async (_formData: FormData): Promise<void> => {};

function render(
  surface: OperationsObservationSurface,
  result: string | null,
  resultReceipt: string | null = null,
): string {
  return renderToStaticMarkup(createElement(OperationsObservation, {
    surface,
    timezone: "UTC",
    recordingAllowed: true,
    result,
    resultReceipt,
    recordAction: noOpAction,
    correctionAction: noOpAction,
  }));
}

describe("operations observation surface", () => {
  it("does not turn a caller-controlled result query into fake success", () => {
    const empty = { targets: [], lineages: [] } satisfies OperationsObservationSurface;
    expect(render(empty, "record-created")).not.toContain("attendance receipt is present");
    expect(render(empty, "correction-created")).not.toContain("correction receipt is present");
  });

  it("renders success and a maximum-length unbroken reason only when durable lineage backs it", () => {
    const reason = "x".repeat(280);
    const surface = {
      targets: [],
      lineages: [{
        originalObservationId: "original-observation",
        personId: "person",
        personName: "Synthetic Participant",
        programUnitId: "unit",
        programUnitName: "Synthetic Session",
        meaning: "ATTENDED",
        observedAt: "2026-08-14T00:00:00.000Z",
        recordedAt: "2026-08-14T00:00:00.001Z",
        state: "superseded",
        correction: {
          relationId: "correction-relation",
          observationId: "correction-observation",
          meaning: "DID_NOT_ATTEND",
          reason,
          actorAccountId: "organizer-account",
          actorDisplayName: "Synthetic Organizer",
          actorRole: "organizer",
          correctedAt: "2026-08-14T00:00:00.001Z",
          recordedAt: "2026-08-14T00:00:00.001Z",
          commandFingerprint: "a".repeat(64),
          state: "current",
        },
      }],
    } satisfies OperationsObservationSurface;

    const forged = render(surface, "correction-created", "unrelated-correction-receipt");
    expect(forged).not.toContain("correction receipt is present");
    const html = renderToStaticMarkup(createElement(OperationsObservation, {
      surface,
      timezone: "UTC",
      recordingAllowed: true,
      result: "correction-created",
      resultReceipt: "correction-relation",
      recordAction: noOpAction,
      correctionAction: noOpAction,
    }));
    expect(html).toContain("correction receipt is present");
    expect(html).toContain(reason);
    expect(html).toContain("superseded");
    expect(html).toContain("current");
  });
});
