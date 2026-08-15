import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DeliveryCenter } from "@/components/delivery-center/delivery-center";
import {
  DeliveryCenterError,
  DeliveryCenterLoading,
  DeliveryCenterNotFound,
} from "@/components/delivery-center/delivery-center-states";
import type { DeliveryCenterProjection } from "@/server/services/delivery-center";

const projection: DeliveryCenterProjection = {
  schema: "sympose-delivery-center/v1",
  workspace: { id: "workspace-1", slug: "northstar", name: "Northstar Network" },
  event: {
    id: "event-1",
    name: "Evidence Forum",
    timezone: "UTC",
    lifecycle: "planning",
  },
  readOnly: true,
  providerContacted: false,
  smtpContacted: false,
  transportDisclosure: "Read-only local evidence only. This page does not contact an email provider or SMTP transport, send messages, retry work, or create delivery state.",
  sources: [
    {
      key: "SPEAKER_COMMUNICATIONS",
      label: "Speaker communications",
      state: "READY",
      itemCount: 3,
      disclosure: "Rendered recipients and messages come from the typed event-scoped local speaker delivery log.",
    },
    {
      key: "SHARED_TASK_REMINDERS",
      label: "Shared-task reminders",
      state: "READY",
      itemCount: 1,
      disclosure: "Rendered reminders come from the typed event-scoped ACTION-task reminder projection.",
    },
    {
      key: "CFP_DECISION_NOTICES",
      label: "CFP decision notices",
      state: "READY",
      itemCount: 1,
      disclosure: "Rendered notices come from current event CFP decision communication receipts.",
    },
    {
      key: "CONTENT_NOTIFICATIONS",
      label: "Content notifications",
      state: "UNAVAILABLE",
      itemCount: 0,
      disclosure: "No existing event-scoped contract exposes a rendered content-notification recipient, subject, and body. Generic outbox payloads are deliberately not read.",
    },
  ],
  items: [
    {
      id: "speaker:pending",
      source: "SPEAKER_COMMUNICATIONS",
      sourceLabel: "Speaker communications",
      kind: "Bulk speaker message",
      status: "PENDING",
      recipient: { displayName: "Ada <Admin>", email: "ada@example.test" },
      subject: "Update <not HTML>",
      body: "Hello Ada,\n\n<img src=x onerror=alert(1)> is plain text.",
      channel: "local",
      attemptCount: 1,
      queuedAt: "2026-08-13T01:00:00.000Z",
      nextAttemptAt: "2026-08-13T01:05:00.000Z",
      deliveredAt: null,
      failureRecorded: null,
      providerReceipt: null,
      statusMeaning: "Queued in a local projection. No send or delivery is claimed.",
    },
    {
      id: "speaker:claimed",
      source: "SPEAKER_COMMUNICATIONS",
      sourceLabel: "Speaker communications",
      kind: "Bulk speaker message",
      status: "CLAIMED",
      recipient: { displayName: "Grace Hopper", email: "grace@example.test" },
      subject: "Claimed update",
      body: "This is claimed only by the local queue.",
      channel: "local",
      attemptCount: 1,
      queuedAt: "2026-08-13T01:01:00.000Z",
      nextAttemptAt: null,
      deliveredAt: null,
      failureRecorded: null,
      providerReceipt: null,
      statusMeaning: "Claimed for local processing. No provider or SMTP handoff is shown.",
    },
    {
      id: "shared-task:failed",
      source: "SHARED_TASK_REMINDERS",
      sourceLabel: "Shared-task reminders",
      kind: "ACTION task reminder · Confirm arrival",
      status: "FAILED",
      recipient: { displayName: "Reminder Recipient", email: "reminder@example.test" },
      subject: "Action due: Confirm arrival",
      body: "Evidence Forum\n\nConfirm arrival\nDue 2026-08-15 UTC",
      channel: "local",
      attemptCount: 3,
      queuedAt: "2026-08-13T01:02:00.000Z",
      nextAttemptAt: "2026-08-13T01:10:00.000Z",
      deliveredAt: null,
      failureRecorded: true,
      providerReceipt: null,
      statusMeaning: "Local processing is recorded as failed. This read-only page does not retry it.",
    },
    {
      id: "cfp:pending-local",
      source: "CFP_DECISION_NOTICES",
      sourceLabel: "CFP decision notices",
      kind: "Accepted proposal notice",
      status: "PENDING",
      recipient: { displayName: "CFP Applicant", email: "applicant@example.test" },
      subject: "Evidence Forum: proposal accepted",
      body: "Your proposal was accepted.",
      channel: "local-inbox-simulation",
      attemptCount: null,
      queuedAt: "2026-08-13T01:03:00.000Z",
      nextAttemptAt: null,
      deliveredAt: null,
      failureRecorded: null,
      providerReceipt: null,
      statusMeaning: "Queued in the local inbox simulation. No send or delivery is claimed.",
    },
    {
      id: "speaker:delivered-local",
      source: "SPEAKER_COMMUNICATIONS",
      sourceLabel: "Speaker communications",
      kind: "Bulk speaker message",
      status: "DELIVERED",
      recipient: { displayName: "Margaret Hamilton", email: "margaret@example.test" },
      subject: "Local delivery state",
      body: "This message has an existing local DELIVERED projection state.",
      channel: "local",
      attemptCount: 2,
      queuedAt: "2026-08-13T01:04:00.000Z",
      nextAttemptAt: null,
      deliveredAt: "2026-08-13T01:05:00.000Z",
      failureRecorded: null,
      providerReceipt: null,
      statusMeaning: "Recorded as DELIVERED by the local projection. No provider or SMTP receipt is exposed.",
    },
  ],
  summary: { total: 5, pending: 2, claimed: 1, delivered: 1, failed: 1 },
};

describe("Delivery Center UI truthfulness", () => {
  it("renders recipient, subject, body, all local states, and the explicit provider boundary", () => {
    const html = renderToStaticMarkup(createElement(DeliveryCenter, { projection }));

    expect(html).toContain('data-testid="delivery-center"');
    expect(html).toContain("Delivery Center");
    expect(html).toContain("Evidence Forum");
    expect(html).toContain("No provider or SMTP contact");
    expect(html).toContain("does not contact an email provider or SMTP transport");
    expect(html).toContain("means locally queued or retrying, not sent");
    expect(html).toContain("CLAIMED");
    expect(html).toContain("DELIVERED");
    expect(html).toContain("FAILED");
    expect(html).toContain("Ada &lt;Admin&gt;");
    expect(html).toContain("ada@example.test");
    expect(html).toContain("Update &lt;not HTML&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; is plain text.");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Attempts");
    expect(html).toContain("Next local attempt");
    expect(html).toContain("Not exposed by source");
    expect(html).toContain("A local failure detail is recorded by the source and withheld");
    expect(html).toContain("Content notifications");
    expect(html).toContain("Generic outbox payloads are deliberately not read");
    expect(html).not.toContain("providerMutation");
    expect(html).not.toContain("payloadFingerprint");
    expect(html).not.toContain("destinationKey");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });

  it("renders a truthful empty state while retaining source errors and unavailable content coverage", () => {
    const empty: DeliveryCenterProjection = {
      ...projection,
      sources: projection.sources.map((source) => source.key === "SPEAKER_COMMUNICATIONS"
        ? { ...source, state: "ERROR", itemCount: 0, disclosure: "This source could not be validated, so none of its rows are shown." }
        : { ...source, state: source.key === "CONTENT_NOTIFICATIONS" ? "UNAVAILABLE" : "EMPTY", itemCount: 0 }),
      items: [],
      summary: { total: 0, pending: 0, claimed: 0, delivered: 0, failed: 0 },
    };
    const html = renderToStaticMarkup(createElement(DeliveryCenter, { projection: empty }));

    expect(html).toContain('data-testid="delivery-center-empty"');
    expect(html).toContain("No supported delivery evidence");
    expect(html).toContain("Nothing is inferred from generic outbox payloads");
    expect(html).toContain("ERROR");
    expect(html).toContain("UNAVAILABLE");
  });

  it("labels a shared-task no-network receipt without presenting it as SMTP delivery", () => {
    const deliveredReminder = {
      ...projection.items[2]!,
      id: "shared-task:no-network-delivered",
      status: "DELIVERED" as const,
      attemptCount: 2,
      nextAttemptAt: null,
      deliveredAt: "2026-08-13T01:07:00.000Z",
      failureRecorded: false,
      providerReceipt: {
        id: "no-network-receipt-ui-1",
        acceptedAt: "2026-08-13T01:07:00.000Z",
        mode: "NO_NETWORK_SIMULATED" as const,
      },
      statusMeaning: "A durable no-network simulated adapter receipt is recorded. No SMTP or external provider delivery is claimed.",
    };
    const html = renderToStaticMarkup(createElement(DeliveryCenter, {
      projection: {
        ...projection,
        items: [deliveredReminder],
        summary: { total: 1, pending: 0, claimed: 0, delivered: 1, failed: 0 },
      },
    }));

    expect(html).toContain("No-network receipt recorded");
    expect(html).toContain("no-network-receipt-ui-1");
    expect(html).toContain("No SMTP or external provider delivery is claimed");
    expect(html).toContain("No provider or SMTP contact");
  });

  it("leads with attention-sorted rendered evidence before transport and source explanation", () => {
    const html = renderToStaticMarkup(createElement(DeliveryCenter, { projection }));
    const records = html.indexOf('id="delivery-center-records"');
    const failed = html.indexOf("Action due: Confirm arrival");
    const retryScheduled = html.indexOf("Update &lt;not HTML&gt;");
    const claimed = html.indexOf("Claimed update");
    const delivered = html.indexOf("Local delivery state");
    const boundary = html.indexOf('data-testid="delivery-center-provider-boundary"');
    const sourceCoverage = html.indexOf('id="delivery-source-coverage-title"');

    expect(records).toBeGreaterThan(-1);
    expect(records).toBeLessThan(failed);
    expect(failed).toBeLessThan(retryScheduled);
    expect(retryScheduled).toBeLessThan(claimed);
    expect(claimed).toBeLessThan(delivered);
    expect(delivered).toBeLessThan(boundary);
    expect(boundary).toBeLessThan(sourceCoverage);
    expect(html).toContain("Bounded retry scheduled");
    expect(html).toContain("Rendered subject");
    expect(html).toContain("Inspect queue and timing evidence");
  });

  it("uses generic route states and never reflects an underlying error message", () => {
    const reset = vi.fn();
    const errorHtml = renderToStaticMarkup(createElement(DeliveryCenterError, { reset }));
    const loadingHtml = renderToStaticMarkup(createElement(DeliveryCenterLoading));
    const notFoundHtml = renderToStaticMarkup(createElement(DeliveryCenterNotFound));

    expect(errorHtml).toContain("Authorized delivery evidence is unavailable");
    expect(errorHtml).toContain("No message, provider, database, or filesystem error details are shown");
    expect(errorHtml).not.toContain("SQLITE_PRIVATE_FAILURE");
    expect(loadingHtml).toContain("No provider or SMTP request is made");
    expect(notFoundHtml).toContain("requested workspace and event combination is not available");
  });

  it("keeps the wide surface responsive and keyboard-visible", () => {
    const css = readFileSync(resolve("src/components/delivery-center/delivery-center.module.css"), "utf8");
    expect(css).toContain(".skipLink:focus");
    expect(css).toContain("@media (max-width: 1024px)");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("white-space: pre-wrap");
    expect(css).toContain("prefers-reduced-motion");
  });
});
