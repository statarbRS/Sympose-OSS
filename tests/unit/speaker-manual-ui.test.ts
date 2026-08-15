import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const roster = readFileSync(resolve("src/components/speaker-ops/speaker-roster.tsx"), "utf8");
const actions = readFileSync(resolve("src/app/w/[workspace]/events/[eventId]/speakers/actions.ts"), "utf8");
const styles = readFileSync(resolve("src/components/speaker-ops/speaker-ops.module.css"), "utf8");

describe("manual speaker organizer UI evidence", () => {
  it("exposes add/edit controls, truthful identity/provenance and delivery semantics, reload guidance, and artifact-aware history", () => {
    expect(roster).toContain("Needs attention");
    expect(roster).toContain("Speaker work queue");
    expect(roster).toContain("Deliverables work queue");
    expect(roster).toContain("Setup and intake");
    expect(roster).toContain("Readiness evidence and activity");
    expect(roster).toContain("Content submissions and approvals");
    expect(roster).toContain("Approval evidence");
    expect(roster).toContain("Structured submission payload");
    expect(roster).toContain("Add a speaker manually");
    expect(roster).toContain('name="fullName"');
    expect(roster).toContain('name="email" type="email"');
    expect(roster).toContain("Create or link speaker");
    expect(roster).toContain("Save profile metadata");
    expect(roster).toContain("Canonical email is read-only after creation");
    expect(roster).toContain("Canonical Person · workspace authority");
    expect(roster).toContain("Event-specific profile · manual provenance");
    expect(roster).toContain("durable delivery evidence is not established");
    expect(roster).toContain("deliveryEvidence.source === \"durable-outbox\"");
    expect(roster).not.toContain("Invitation not sent");
    expect(roster).not.toContain("No invitation or outbox delivery was created");
    expect(roster).not.toContain("record.updatedAt}`");
    expect(roster).toContain('name="expectedFullName"');
    expect(roster).toContain("Manual speaker entries are temporarily unavailable");
    expect(roster).toContain('status === "unavailable"');
    expect(roster).toContain("appears in this event roster after reload");
    expect(roster).toContain("ArtifactBrowser");
    expect(roster).toContain("ManualSpeakerRow");
    expect(roster).toContain("<SpeakerDeliverables workspace={workspace} projection={projection} />");
    expect(roster).toContain("function SpeakerDeliverables({ workspace, projection }");
    expect(roster).toContain("action={`/w/${workspace}/events/${projection.event.id}/speakers/content/export`}");
    expect(roster).not.toContain("action={`/w/${projection.access.workspaceId}/events/${projection.event.id}/speakers/content/export`}");
    expect(actions).toContain("export async function createManualSpeaker");
    expect(actions).toContain("export async function editManualSpeaker");
    expect(actions).toContain("manualSpeakerCreateIdempotencyKey");
    expect(actions).toContain("manualSpeakerEditIdempotencyKey");
    expect(styles).toContain(".manualSpeakerNote");
    expect(styles).toContain(".attentionPanel");
    expect(styles).toContain(".setupDisclosure");
    expect(styles).toContain(".auditDisclosure");
    expect(styles).toContain(".versionDisclosure");
    expect(styles).toContain("@media (max-width: 700px)");
    expect(styles).toContain("content: attr(data-label)");
    expect(styles).toContain(":focus-visible");
  });

  it("formats both organizer as-of views and agrees on singular versus plural review copy", () => {
    expect(roster.match(/formatDateTime\(projection\.asOf\)/gu)).toHaveLength(2);
    expect(roster).not.toContain("value={projection.asOf}");
    expect(roster).not.toContain("As of {projection.asOf}");
    expect(roster).toContain('${contentReviewCount === 1 ? "needs" : "need"} review');
    expect(roster).not.toContain('content stream${contentReviewCount === 1 ? "" : "s"} need review');
  });
});
