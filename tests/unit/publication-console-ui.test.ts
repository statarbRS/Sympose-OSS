import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SealPublicationActionState } from "@/app/w/[workspace]/events/[eventId]/publication/actions";
import {
  CompletedPublicationCeremony,
  formatEventTime,
  PublicationConsole,
  publicationCeremonyPhase,
} from "@/components/public-agenda/publication-console";
import {
  toPublicationConsoleAudienceMatrix,
  toPublicationConsoleRelease,
} from "@/components/public-agenda/publication-console-model";
import type { ValidatedPublicRelease } from "@/server/services/publication";
import type { PublicationAudienceMatrix } from "@/server/services/publication-audience";

const currentRelease: ValidatedPublicRelease = {
  workspaceId: "workspace-1",
  eventId: "event-1",
  releaseId: "release-1",
  planVersionId: "plan-1",
  audiencePolicyVersion: 1,
  commitmentWatermark: 1,
  fingerprint: "a".repeat(64),
  sealedAt: "2026-08-13T01:00:00.000Z",
  current: true,
  content: {
    schema: "publication-release/v2",
    event: {
      id: "event-1",
      name: "Evidence Forum",
      timezone: "UTC",
      startsAt: "2026-09-15T09:00:00.000Z",
      endsAt: "2026-09-15T17:00:00.000Z",
    },
    plan: { id: "plan-1", versionNumber: 4, fingerprint: "b".repeat(64) },
    audiencePolicyVersion: 1,
    commitmentWatermark: 1,
    accepted: [{
      personId: "person-1",
      personName: "Ada Lovelace",
      email: "ada.private@example.test",
      offerId: "offer-1",
      termsFingerprint: "c".repeat(64),
      programUnitId: "session-1",
      programUnitName: "Opening session",
      role: "speaker",
      startsAt: "2026-09-15T09:00:00.000Z",
      endsAt: "2026-09-15T10:00:00.000Z",
    }],
    agendas: [{
      personId: "person-1",
      personName: "Ada Lovelace",
      email: "ada.private@example.test",
      items: [{
        programUnitId: "session-1",
        programUnitName: "Opening session",
        role: "speaker",
        startsAt: "2026-09-15T09:00:00.000Z",
        endsAt: "2026-09-15T10:00:00.000Z",
      }],
    }],
  },
};

const action = async (): Promise<SealPublicationActionState> => ({
  ok: true,
  code: "IDLE",
  message: "",
  release: null,
});

const audienceAction = async () => {};

const audienceMatrix: PublicationAudienceMatrix = {
  schema: "publication-audience-matrix/v1",
  workspaceId: "workspace-1",
  eventId: "event-1",
  currentReleaseId: "release-1",
  currentReleaseValidated: true,
  releases: [{
    id: "publication-release-version:release-1",
    workspaceId: "workspace-1",
    eventId: "event-1",
    releaseId: "release-1",
    versionNumber: 1,
    releaseFingerprint: "a".repeat(64),
    sealedAt: "2026-08-13T01:00:00.000Z",
    catalogSource: "COMMAND",
    catalogedByAccountId: "account-1",
    catalogedAt: "2026-08-13T01:01:00.000Z",
    catalogFingerprint: "d".repeat(64),
  }],
  channels: [{
    id: "channel-1",
    workspaceId: "workspace-1",
    eventId: "event-1",
    key: "public-agenda",
    label: "Public agenda",
    purpose: "EVENT_AGENDA",
    audience: "PUBLIC",
    visibility: "PUBLIC",
    initialState: "ACTIVE",
    currentState: "ACTIVE",
    createdByAccountId: "account-1",
    createdAt: "2026-08-13T01:01:00.000Z",
    fingerprint: "e".repeat(64),
  }],
  policies: [{
    id: "policy-1",
    workspaceId: "workspace-1",
    eventId: "event-1",
    channelId: "channel-1",
    versionNumber: 1,
    purpose: "EVENT_AGENDA",
    audience: "PUBLIC",
    visibility: "PUBLIC",
    storedState: "DRAFT",
    currentState: "BOUND",
    rule: "PUBLIC_SCHEDULE",
    policySchema: "publication-audience-policy/v1",
    policyFingerprint: "f".repeat(64),
    createdByAccountId: "account-1",
    createdAt: "2026-08-13T01:02:00.000Z",
  }],
  receipts: [],
  rows: [{
    key: "1:EVENT_AGENDA:PUBLIC:PUBLIC:public-agenda:channel-1",
    releaseVersionId: "publication-release-version:release-1",
    releaseId: "release-1",
    releaseVersion: 1,
    releaseFingerprint: "a".repeat(64),
    releaseSealedAt: "2026-08-13T01:00:00.000Z",
    channelId: "channel-1",
    channelKey: "public-agenda",
    channelLabel: "Public agenda",
    purpose: "EVENT_AGENDA",
    audience: "PUBLIC",
    visibility: "PUBLIC",
    policyVersionId: "policy-1",
    policyVersion: 1,
    bindingReceiptId: "binding-receipt-1",
    status: "CURRENT",
    reason: "The receipt exactly matches the validated current immutable release.",
    receipts: [],
  }],
  fingerprint: "9".repeat(64),
};
const browserAudienceMatrix = toPublicationConsoleAudienceMatrix(audienceMatrix);

describe("Publication Console hierarchy", () => {
  it("keeps ready, sealing, and sealed mutually exclusive and requires an executed receipt", () => {
    const idle: SealPublicationActionState = { ok: true, code: "IDLE", message: "", release: null };
    const executed: SealPublicationActionState = {
      ok: true,
      code: "PUBLICATION_RELEASE_SEALED",
      message: "Executed",
      release: { releaseId: "release-2", fingerprint: "f".repeat(64), agendaCount: 1, created: true },
    };
    expect(publicationCeremonyPhase(false, idle)).toBe("READY");
    expect(publicationCeremonyPhase(true, executed)).toBe("SEALING");
    expect(publicationCeremonyPhase(false, executed)).toBe("SEALED");
    expect(publicationCeremonyPhase(false, idle)).toBe("READY");
    expect(publicationCeremonyPhase(false, idle)).not.toBe("SEALED");
  });

  it("leads with audience counts and comparison before boundary and lineage internals", () => {
    const html = renderToStaticMarkup(createElement(PublicationConsole, {
      workspaceSlug: "northstar",
      event: currentRelease.content.event,
      currentRelease: toPublicationConsoleRelease(currentRelease),
      action,
    }));
    const preview = html.indexOf('id="audience-preview-title"');
    const comparison = html.indexOf('data-testid="publication-release-comparison"');
    const boundary = html.indexOf('id="redaction-contract-title"');
    const lineage = html.indexOf('id="publication-lineage-title"');
    const countsStart = html.indexOf('data-testid="publication-audience-counts"');
    const counts = html.slice(countsStart, html.indexOf("</dl>", countsStart));

    expect(preview).toBeGreaterThan(-1);
    expect(preview).toBeLessThan(comparison);
    expect(comparison).toBeLessThan(boundary);
    expect(boundary).toBeLessThan(lineage);
    expect(counts).toContain("Included agendas</dt><dd>1");
    expect(counts).toContain("Excluded accepted people</dt><dd>0");
    expect(counts).toContain("Redacted field groups</dt><dd>6");
    expect(html).toContain("Pre-seal diff is not exposed by this service");
    expect(html).toContain('data-release-state="READY"');
    expect(html).toContain("Validate current authoritative inputs");
    expect(html).toContain("Check and seal exact current inputs");
    expect(html).not.toContain("Retry seal (idempotent)");
    expect(html).not.toContain('data-testid="publication-seal-receipt"');
    expect(html).not.toContain('open=""');
    expect(html).toContain('data-testid="organizer-source-release"');
    expect(html).not.toContain("ada.private@example.test");
    expect(JSON.stringify(toPublicationConsoleRelease(currentRelease))).not.toContain("ada.private@example.test");
  });

  it("keeps audience and comparison layouts reflowable at the mobile breakpoint", () => {
    const css = readFileSync(resolve("src/components/public-agenda/publication-console.module.css"), "utf8");
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("prefers-reduced-motion");
  });

  it("formats the audience preview from the sealed event timezone, never mutable route state", () => {
    const sealedTimezone = "America/New_York";
    const mutableTimezone = "Asia/Tokyo";
    const sealedRelease: ValidatedPublicRelease = {
      ...currentRelease,
      content: {
        ...currentRelease.content,
        event: { ...currentRelease.content.event, timezone: sealedTimezone },
      },
    };
    const mutableEvent = { ...currentRelease.content.event, timezone: mutableTimezone };
    const html = renderToStaticMarkup(createElement(PublicationConsole, {
      workspaceSlug: "northstar",
      event: mutableEvent,
      currentRelease: toPublicationConsoleRelease(sealedRelease),
      action,
    }));
    const format = (timezone: string) => new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date("2026-09-15T09:00:00.000Z"));
    const sealedDisplay = formatEventTime(currentRelease.sealedAt, sealedTimezone);

    expect(html).toContain(`${format(sealedTimezone)} · ${sealedTimezone}`);
    expect(html).not.toContain(format(mutableTimezone));
    expect(html).toContain(`data-testid="publication-sealed-at" dateTime="${currentRelease.sealedAt}"`);
    expect(html).toContain(`data-testid="publication-lineage-sealed-at" dateTime="${currentRelease.sealedAt}"`);
    expect(html.match(new RegExp(sealedDisplay.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(2);
    expect(html).not.toContain(`>${currentRelease.sealedAt}</time>`);
  });

  it("labels UTC fallback and unformatted publication timestamps without inventing event-local truth", () => {
    const instant = "2026-08-13T01:00:00.000Z";
    const utc = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(instant));

    expect(formatEventTime(instant, "Mars/Olympus")).toBe(
      `${utc} · UTC fallback; requested timezone Mars/Olympus unavailable`,
    );
    expect(formatEventTime("not-an-instant", "UTC")).toBe(
      "Unformatted timestamp · not-an-instant",
    );
  });

  it("renders exact matrix evidence and organizer receipt controls without pointer authority inputs", () => {
    const html = renderToStaticMarkup(createElement(PublicationConsole, {
      workspaceSlug: "northstar",
      event: currentRelease.content.event,
      currentRelease: toPublicationConsoleRelease(currentRelease),
      action,
      audienceMatrix: browserAudienceMatrix,
      audienceAction,
    }));
    expect(html).toContain("Version-to-Audience Matrix");
    expect(html).toContain('data-testid="publication-audience-matrix"');
    expect(html).toContain('data-status="CURRENT"');
    expect(html).not.toContain("No exact policy-and-release authority");
    expect(html).toContain('name="expectedReleaseId" value="release-1"');
    expect(html).toContain('name="expectedReleaseVersion" value="1"');
    expect(html).toContain(`name="expectedReleaseFingerprint" value="${"a".repeat(64)}"`);
    expect(html).toContain("this matrix never changes or gates the established public pointer");
    expect(html).not.toContain('name="workspaceId"');
    expect(html).not.toContain('name="eventId"');
    const serialized = JSON.stringify(browserAudienceMatrix);
    expect(serialized).not.toContain('"workspaceId"');
    expect(serialized).not.toContain('"eventId"');
    expect(serialized).not.toContain("catalogedByAccountId");
    expect(serialized).not.toContain("createdByAccountId");
    expect(serialized).not.toContain("actorAccountId");
    expect(serialized).not.toContain("requestFingerprint");
    expect(serialized).not.toContain("catalogFingerprint");
    expect(serialized).not.toContain("account-1");
    expect(serialized).not.toContain("workspace-1");
    expect(serialized).not.toContain("event-1");
    expect(serialized).not.toContain("idempotencyKey");
    expect(serialized).not.toContain("createdByAccountId");
    expect(serialized).not.toContain('"receipts"');
  });

  it("offers the first seal only in the ready attempt state", () => {
    const html = renderToStaticMarkup(createElement(PublicationConsole, {
      workspaceSlug: "northstar",
      event: { id: "event-1" },
      currentRelease: null,
      action,
    }));

    expect(html).toContain('data-release-state="READY"');
    expect(html).toContain("Run checks and seal");
    expect(html).not.toContain("Check and seal exact current inputs");
    expect(html).not.toContain('data-testid="publication-seal-receipt"');
  });

  it("renders the completed seal receipt without any unexecuted seal control", () => {
    const html = renderToStaticMarkup(createElement(CompletedPublicationCeremony, {
      release: {
        releaseId: "release-2",
        fingerprint: "f".repeat(64),
        agendaCount: 1,
        created: true,
      },
      message: "The exact immutable successor is durable.",
      hadBaseline: true,
      reviewHref: "/w/northstar/events/event-1/publication",
    }));

    expect(html).toContain('data-release-state="SEALED"');
    expect(html).toContain("Immutable successor release sealed");
    expect(html).toContain('data-testid="publication-seal-receipt"');
    expect(html).toContain("Review current release");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Run checks and seal");
    expect(html).not.toContain("Check and seal exact current inputs");
  });
});
