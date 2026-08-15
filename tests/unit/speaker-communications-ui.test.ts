import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SpeakerCommunicationsPanel } from "@/components/speaker-communications-panel";
import type { SpeakerCommunicationsSurface } from "@/app/w/[workspace]/events/[eventId]/speakers/communications/actions";

const surface: SpeakerCommunicationsSurface = {
  workspace: "northstar",
  event: { id: "event-speaker-comms-ui", name: "Evidence Forum" },
  recipients: [
    {
      personId: "person-ada",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      organization: "Analytical Engines Lab",
      title: "Research Director",
      roles: ["SPEAKER"],
    },
    {
      personId: "person-bruno",
      displayName: "Bruno Silva",
      email: "bruno@example.test",
      organization: "Synthetic Commons",
      title: "Community Moderator",
      roles: ["MODERATOR"],
    },
  ],
  history: [
    {
      messageId: "message-ada",
      domainEventId: "batch-1",
      workspaceId: "workspace-northstar",
      eventId: "event-speaker-comms-ui",
      personId: "person-ada",
      normalizedEmail: "ada@example.test",
      displayName: "Ada Lovelace",
      destinationKey: "local:speaker-communication:event-speaker-comms-ui:person-ada:one",
      templateKey: "speaker-bulk-local-v1",
      subjectPreview: "Update for Evidence Forum",
      bodyPreview: "Hi Ada,\n\nThe local queue is ready.",
      payloadFingerprint: "fingerprint-message-ada",
      status: "PENDING",
      attemptCount: 0,
      nextAttemptAt: "2026-08-12T12:00:00.000Z",
      createdAt: "2026-08-12T12:00:00.000Z",
      deliveredAt: null,
      channel: "local",
      providerMutation: false,
    },
  ],
  nextIdempotencyKey: "speaker-communications:event-speaker-comms-ui:1",
};

describe("speaker communications console UI", () => {
  it("renders canonical recipient selection, bounded plain-text fields, and local-only copy", () => {
    const html = renderToStaticMarkup(createElement(SpeakerCommunicationsPanel, { surface }));

    expect(html).toContain('data-testid="speaker-communications-panel"');
    expect(html).toContain("Speaker communications");
    expect(html).toContain("Evidence Forum");
    expect(html).toContain('name="workspace" value="northstar"');
    expect(html).toContain('name="eventId" value="event-speaker-comms-ui"');
    expect(html).toContain('name="personId"');
    expect(html).toContain('value="person-ada"');
    expect(html).toContain('value="person-bruno"');
    expect(html).toContain('name="subjectTemplate"');
    expect(html).toContain('maxLength="240"');
    expect(html).toContain('name="bodyTemplate"');
    expect(html).toContain('maxLength="12000"');
    expect(html).toContain("{{eventName}}");
    expect(html).toContain("Rendered preview");
    expect(html).toContain("No email provider is connected.");
    expect(html).toContain("PENDING");
    expect(html).toContain("Queue history");
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain("providerMutation");
  });

  it("renders a safe empty audience state without offering a queue mutation", () => {
    const html = renderToStaticMarkup(createElement(SpeakerCommunicationsPanel, {
      surface: {
        ...surface,
        recipients: [],
        history: [],
        nextIdempotencyKey: "speaker-communications:event-speaker-comms-ui:0",
      },
    }));

    expect(html).toContain("No event-scoped speakers are available for this message.");
    expect(html).toContain("No local speaker communication batches have been queued for this event.");
    expect(html).toContain("Select at least one recipient.");
    expect(html).toContain('disabled=""');
  });
});
