import { describe, expect, it } from "vitest";
import {
  parsePublishedEventProjection,
  safeParsePublishedEventProjection,
  SYNTHETIC_PUBLIC_PROJECTION,
  toPublicWidgetProjection,
  type PublishedEventProjection,
} from "@/server/services/public-widgets/contracts";
import {
  createPublicWidgetCatalog,
  PublicWidgetNotFoundError,
} from "@/server/services/public-widgets/catalog";

const SYNTHETIC_PUBLIC_WIDGET_WORKSPACE_ID = SYNTHETIC_PUBLIC_PROJECTION.workspaceId;
const SYNTHETIC_PUBLIC_WIDGET_CHANNEL_REFERENCE = toPublicWidgetProjection(
  SYNTHETIC_PUBLIC_PROJECTION,
).release.channelReference;

describe("public widget publication projection boundary", () => {
  it("deep-freezes the synthetic input and redacts organizer/private material", () => {
    const widget = toPublicWidgetProjection(SYNTHETIC_PUBLIC_PROJECTION);

    expect(Object.isFrozen(SYNTHETIC_PUBLIC_PROJECTION)).toBe(true);
    expect(Object.isFrozen(SYNTHETIC_PUBLIC_PROJECTION.release)).toBe(true);
    expect(Object.isFrozen(SYNTHETIC_PUBLIC_PROJECTION.sessions)).toBe(true);
    expect(Object.isFrozen(widget)).toBe(true);
    expect(widget.sessions).toHaveLength(4);
    expect(widget.speakers).toHaveLength(3);
    expect(JSON.stringify(widget)).not.toContain("workspace-synthetic-public");
    expect(JSON.stringify(widget)).not.toContain("release-synthetic-public-v1");
    expect(JSON.stringify(widget)).not.toContain("organizer-only");
    expect(JSON.stringify(widget)).not.toContain("Private planning team");
    expect(JSON.stringify(widget)).not.toContain("javascript:");
  });

  it("filters an approved record's unsafe photo URL without allowing a browser URL sink", () => {
    const hostile = structuredClone(SYNTHETIC_PUBLIC_PROJECTION) as unknown as PublishedEventProjection;
    const speaker = hostile.speakers.find((candidate) => candidate.displayName === "Jon Bell");
    if (!speaker) throw new Error("fixture speaker missing");
    const mutableSpeaker = speaker as { photoUrl: string | null };
    mutableSpeaker.photoUrl = "javascript:alert(1)";

    const widget = toPublicWidgetProjection(hostile);
    expect(widget.speakers.find((candidate) => candidate.displayName === "Jon Bell")?.photoUrl).toBeNull();
  });

  it("rejects malformed projection input with a bounded public error", () => {
    const result = safeParsePublishedEventProjection({ schema: "wrong/v1", secret: "do-not-return" });
    expect(result).toEqual({
      success: false,
      error: {
        code: "INVALID_PUBLISHED_EVENT_PROJECTION",
        message: "projection schema is unsupported.",
      },
    });
    expect(() => parsePublishedEventProjection({ schema: "wrong/v1" })).toThrow(/schema is unsupported/u);
  });

  it("resolves only the server-bound tenant and exact authorized current release", () => {
    const catalog = createPublicWidgetCatalog([
      { workspaceId: SYNTHETIC_PUBLIC_WIDGET_WORKSPACE_ID, projection: SYNTHETIC_PUBLIC_PROJECTION },
    ]);
    const widget = catalog.resolve({
      workspaceId: SYNTHETIC_PUBLIC_WIDGET_WORKSPACE_ID,
      channelReference: SYNTHETIC_PUBLIC_WIDGET_CHANNEL_REFERENCE,
      releaseId: "release-synthetic-public-v1",
    });
    expect(widget.release.channelReference).toBe(widget.release.releaseReference);

    for (const lookup of [
      { workspaceId: "other-workspace", channelReference: SYNTHETIC_PUBLIC_WIDGET_CHANNEL_REFERENCE },
      { workspaceId: SYNTHETIC_PUBLIC_WIDGET_WORKSPACE_ID, channelReference: SYNTHETIC_PUBLIC_WIDGET_CHANNEL_REFERENCE, releaseId: "wrong-release" },
      { workspaceId: SYNTHETIC_PUBLIC_WIDGET_WORKSPACE_ID, channelReference: "missing-channel" },
    ]) {
      expect(() => catalog.resolve(lookup)).toThrow(PublicWidgetNotFoundError);
      expect(() => catalog.resolve(lookup)).toThrow("Public widget not found.");
    }
  });

  it("rejects a binding that is not tenant-consistent before it can be catalogued", () => {
    expect(() => createPublicWidgetCatalog([
      { workspaceId: "other-workspace", projection: SYNTHETIC_PUBLIC_PROJECTION },
    ])).toThrow("PUBLIC_WIDGET_BINDING_TENANT_MISMATCH");
  });

  it("does not expose superseded or revoked releases through a stable channel", () => {
    const superseded = structuredClone(SYNTHETIC_PUBLIC_PROJECTION) as unknown as PublishedEventProjection;
    (superseded.release as { current: boolean }).current = false;
    expect(() => createPublicWidgetCatalog([
      { workspaceId: SYNTHETIC_PUBLIC_WIDGET_WORKSPACE_ID, projection: superseded },
    ])).toThrow(PublicWidgetNotFoundError);

    const revoked = structuredClone(SYNTHETIC_PUBLIC_PROJECTION) as unknown as PublishedEventProjection;
    (revoked.release as { revokedAt: string | null }).revokedAt = "2026-08-12T00:00:00.000Z";
    expect(() => createPublicWidgetCatalog([
      { workspaceId: SYNTHETIC_PUBLIC_WIDGET_WORKSPACE_ID, projection: revoked },
    ])).toThrow(PublicWidgetNotFoundError);
  });
});
