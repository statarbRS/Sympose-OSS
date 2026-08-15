import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { closeDb, openDb } from "@/server/db";

import EventOverviewPage from "@/app/w/[workspace]/events/[eventId]/overview/page";
import PublicationPage from "@/app/w/[workspace]/events/[eventId]/publication/page";
import ReviewPage from "@/app/w/[workspace]/events/[eventId]/review/page";
import ProgramPage from "@/app/w/[workspace]/events/[eventId]/program/page";
import SpeakersPage from "@/app/w/[workspace]/events/[eventId]/speakers/page";
import OperationsPage from "@/app/w/[workspace]/events/[eventId]/operations/page";
import MemoryPage from "@/app/w/[workspace]/memory/page";
import { EventSwitcher } from "@/app/w/[workspace]/events/_components/event-switcher";
import {
  EventProductSurface,
  ProgramCapacityProjection,
  WorkspaceMemorySurface,
} from "@/app/w/[workspace]/events/[eventId]/_components/product-surface";
import { SurfaceError, SurfaceLoading, SurfaceNotFound } from "@/app/w/[workspace]/events/[eventId]/_components/surface-route-states";
import type { CapacityLedger, CapacityPool, CapacityTransferHistoryEntry } from "@/server/services/program-capacity";
import { createProgramCapacityPool, getProgramCapacitySurfaceProjection } from "@/server/services/program-capacity";
import { listEvents } from "@/server/services/events";

const event = { id: "event-ui", name: "Synthetic Symposium" };
const productShellSource = readFileSync(resolve("src/components/product-shell/product-shell.tsx"), "utf8");
const workspaceShellStyles = readFileSync(resolve("src/app/w/[workspace]/shell.css"), "utf8");
const eventSurfaceStyles = readFileSync(resolve("src/app/w/[workspace]/events/[eventId]/_components/product-surface.module.css"), "utf8");
const eventOverviewSource = readFileSync(resolve("src/app/w/[workspace]/events/[eventId]/overview/page.tsx"), "utf8");

const ledger: CapacityLedger = {
  schema: "pd01-capacity-ledger/v1", workspaceId: "workspace-ui", eventId: event.id,
  sequenceNumber: 7, ledgerFingerprint: "ledger-fingerprint-7",
  pools: [{ poolId: "main", poolName: "Main pool", unitKind: "SEAT", versionId: "main-v1", versionNumber: 1, latestVersionId: "main-v2", latestVersionNumber: 2, capacity: 10, remaining: 7, remainingCapacity: 7, transferredIn: 1, transferredOut: 4 }],
  totalCapacity: 10, totalRemaining: 7,
};

const pools: CapacityPool[] = [{
  id: "main", workspaceId: "workspace-ui", eventId: event.id, unitKind: "SEAT", name: "Main pool",
  createdAt: "2026-08-10T00:00:00.000Z", archivedAt: null,
  currentVersion: { id: "main-v2", workspaceId: "workspace-ui", eventId: event.id, poolId: "main", versionNumber: 2, unitKind: "SEAT", capacity: 10, scope: { track: "main" }, eligibility: { audience: "member" }, reservedFor: { sponsor: 2 }, releasePolicy: { permitted: true }, effectiveFrom: "2026-08-10T00:00:00.000Z", effectiveTo: null, fingerprint: "pool-version-fingerprint", createdAt: "2026-08-10T00:00:00.000Z" },
}];

const history: CapacityTransferHistoryEntry[] = [{
  receiptId: "receipt:decision-7", decisionId: "decision-7", workspaceId: "workspace-ui", eventId: event.id, sequenceNumber: 7,
  sourcePoolId: "main", sourcePoolVersionId: "main-v1", destinationPoolId: "sponsor", destinationPoolVersionId: "sponsor-v1", unitKind: "SEAT", quantity: 2, sourceBefore: 9, sourceAfter: 7, destinationBefore: 1, destinationAfter: 3, recordedAt: "2026-08-11T09:00:00.000Z", fingerprint: "receipt-source-fingerprint", actorAccountId: "organizer-ui", reason: "Approved sponsor allocation", approvalReference: "approval-42", decidedAt: "2026-08-11T09:00:00.000Z", idempotencyKey: "capacity-command-7", operation: "release",
}];

describe("PD-01 rendered product surfaces", () => {
  it("keeps every workspace destination reachable from the compact mobile row", () => {
    expect(productShellSource).toContain("const mobileNavItems");
    expect(productShellSource).toContain("const mobileMoreItems");
    expect(productShellSource).toContain('id === "crm" ? "People" : label');
    expect(productShellSource).toContain('aria-label="More workspace destinations"');
    expect(productShellSource).toContain("mobileMoreItems.map");

    const compactStart = workspaceShellStyles.indexOf("@media (max-width: 768px)", workspaceShellStyles.indexOf("/* Product shell foundation."));
    const compactEnd = workspaceShellStyles.indexOf("@media (max-width: 420px)", compactStart);
    const compactStyles = workspaceShellStyles.slice(compactStart, compactEnd);
    expect(compactStyles).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(compactStyles).toContain("position: sticky;");
    expect(compactStyles).toContain(".productShell__mobile-more-panel");
    expect(compactStyles).not.toContain("position: fixed;");
  });

  it("renders a useful event overview from existing records and workflows", () => {
    expect(eventOverviewSource).not.toContain("Projection unavailable");
    expect(eventOverviewSource).not.toContain("UnavailableState");
    expect(eventOverviewSource).toContain("Open Readiness");
    expect(eventOverviewSource).toContain("Current plan pointer");
    expect(eventOverviewSource).toContain("Current release pointer");
    for (const path of ["readiness", "cfp", "review", "speakers", "program", "plan", "publication", "operations"]) {
      expect(eventOverviewSource).toContain(`path: "${path}"`);
    }
  });

  it("renders exact event nav hrefs and accessible landmarks", () => {
    const html = renderToStaticMarkup(createElement(EventProductSurface, {
      workspace: "northstar", event, active: "program", eyebrow: "Program Builder", title: "Program structure and capacity", description: "Read-only surface.",
      children: createElement("p", null, "Content"),
    }));
    expect(html).toContain('href="/w/northstar/events/event-ui/overview"');
    expect(html).toContain('href="/w/northstar/events/event-ui/review"');
    expect(html).toContain('href="/w/northstar/events/event-ui/program"');
    expect(html).toContain('href="/w/northstar/events/event-ui/speakers"');
    expect(html).toContain('href="/w/northstar/events/event-ui/publication"');
    expect(html).toContain('href="/w/northstar/events/event-ui/operations"');
    expect(html).toContain('href="/w/northstar/events"');
    expect(html).toContain('href="/w/northstar/memory"');
    expect(html).toContain('aria-label="Event product surfaces"');
    expect(html).toContain("Skip to event surface");
    expect(html).toContain('aria-current="page"');
  });

  it("keeps an overflowing event navigation discoverable without hiding keyboard focus", () => {
    const compactStart = eventSurfaceStyles.lastIndexOf("@media (max-width: 767px)");
    const overflowStyles = eventSurfaceStyles.slice(0, compactStart);
    const compactStyles = eventSurfaceStyles.slice(compactStart);

    expect(overflowStyles).toContain("scroll-padding-inline: 1rem;");
    expect(overflowStyles).toContain("scroll-margin-inline: 1rem;");
    expect(overflowStyles).toContain("scrollbar-color: var(--border-strong) transparent;");
    expect(overflowStyles).toContain("background-attachment: local, local, scroll, scroll;");
    expect(overflowStyles).toMatch(/\.contextLinkActive\s*\{[^}]*position: sticky;[^}]*inset-inline: 0\.5rem;/su);
    expect(overflowStyles).toMatch(/\.contextLink:focus-visible\s*\{[^}]*position: sticky;[^}]*inset-inline: 0\.5rem;[^}]*z-index: 2;/su);
    expect(compactStyles).not.toContain(".contextNav");
    expect(eventSurfaceStyles).not.toContain("scroll-behavior: smooth");
  });

  it("renders the workspace event switcher with explicit event entry points", () => {
    const html = renderToStaticMarkup(createElement(EventSwitcher, {
      workspace: "northstar",
      events: [
        {
          id: "event-one",
          name: "Northstar Summit",
          timezone: "UTC",
          startsAt: "2026-09-15T09:00:00.000Z",
          endsAt: "2026-09-15T13:00:00.000Z",
          lifecycle: "planning",
          currentPlanVersionId: null,
          currentReleaseId: null,
          createdAt: "2026-08-10T00:00:00.000Z",
        },
        {
          id: "event-two",
          name: "Northstar Workshop",
          timezone: "UTC",
          startsAt: "2026-10-15T09:00:00.000Z",
          endsAt: "2026-10-15T13:00:00.000Z",
          lifecycle: "draft",
          currentPlanVersionId: "plan-two",
          currentReleaseId: "release-two",
          createdAt: "2026-08-11T00:00:00.000Z",
        },
      ],
    }));

    expect(html).toContain("Northstar Summit");
    expect(html).toContain("Northstar Workshop");
    expect(html).toContain('href="/w/northstar/events/event-one/overview"');
    expect(html).toContain('href="/w/northstar/events/event-two/overview"');
    expect(html).toContain('href="/w/northstar/dashboard"');
    expect(html).toContain("Create event");
    expect(html).toContain('name="returnToPortfolio"');
    expect(html).toContain("CFP, review, and speaker records are not copied");
    expect(html).toContain("Workspace-scoped");

    const secondEventHtml = renderToStaticMarkup(createElement(EventSwitcher, {
      workspace: "acme",
      events: [{
        id: "acme-event-one",
        name: "Acme Evaluator Summit",
        timezone: "UTC",
        startsAt: "2026-09-18T09:00:00.000Z",
        endsAt: "2026-09-18T17:00:00.000Z",
        lifecycle: "planning",
        currentPlanVersionId: "plan-one",
        currentReleaseId: "release-one",
        createdAt: "2026-08-01T12:00:00.000Z",
      }],
    }));
    expect(secondEventHtml).toContain("Create a second event");
    expect(secondEventHtml).toContain('data-testid="create-second-event"');
    expect(secondEventHtml).toContain('value="Acme Evaluator Workshop"');
    expect(secondEventHtml).toContain('value="Second synthetic session"');
    expect(secondEventHtml).toContain('value="24"');
  });

  it("lists events only for the requested workspace", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstarId = (db.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as { id: string }).id;
      const acmeId = (db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { id: string }).id;
      const insertEvent = db.prepare(`INSERT INTO events
        (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
        VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`);
      insertEvent.run("northstar-event-one", northstarId, "Northstar Summit", "2026-09-15T09:00:00.000Z", "2026-09-15T13:00:00.000Z", "2026-08-10T00:00:00.000Z");
      insertEvent.run("northstar-event-two", northstarId, "Northstar Workshop", "2026-10-15T09:00:00.000Z", "2026-10-15T13:00:00.000Z", "2026-08-11T00:00:00.000Z");
      insertEvent.run("acme-event-one", acmeId, "Acme Summit", "2026-09-15T09:00:00.000Z", "2026-09-15T13:00:00.000Z", "2026-08-10T00:00:00.000Z");

      const northstarEvents = listEvents(db, northstarId);
      expect(northstarEvents.map((event) => event.name)).toEqual([
        "Northstar Summit",
        "Northstar Workshop",
      ]);
      expect(northstarEvents.map((event) => event.name)).not.toContain("Acme Summit");
      expect(listEvents(db, acmeId).map((event) => event.name)).toEqual(["Acme Summit"]);
    } finally {
      closeDb(db);
    }
  });

  it("has real route modules for every contract target", () => {
    for (const route of [EventOverviewPage, PublicationPage, ReviewPage, ProgramPage, SpeakersPage, OperationsPage, MemoryPage]) {
      expect(route).toBeTypeOf("function");
    }
  });

  it("keeps workspace memory navigation workspace-scoped", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceMemorySurface, {
      workspace: "northstar", workspaceName: "Northstar Network", children: createElement("p", null, "Memory"),
    }));
    expect(html).toContain('href="/w/northstar/memory"');
    expect(html).not.toContain("event-ui");
    expect(html).toContain("Evidence across events");
  });

  it("renders real P3 values and receipts without raw policy JSON", () => {
    const html = renderToStaticMarkup(createElement(ProgramCapacityProjection, { ledger, pools, history }));
    expect(html).toContain("Server-owned balance projection");
    expect(html).toContain("ledger-fingerprint-7");
    expect(html).toContain("main-v1");
    expect(html).toContain("main-v2");
    expect(html).toContain("Configured");
    expect(html).toContain("Details withheld from this projection");
    expect(html).not.toContain('"audience":"member"');
    expect(html).toContain("Sequence 7 · release");
    expect(html).toContain("organizer-ui");
    expect(html).toContain("Approved sponsor allocation");
    expect(html).toContain("approval-42");
    expect(html).toContain("receipt:decision-7");
    expect(html).toContain("receipt-source-fingerprint");
  });

  it("renders bounded empty and route states without domain leakage", () => {
    const emptyHtml = renderToStaticMarkup(createElement(ProgramCapacityProjection, { ledger: { ...ledger, pools: [], totalCapacity: 0, totalRemaining: 0 }, pools: [], history: [] }));
    expect(emptyHtml).toContain("No capacity pools exist for this event");
    expect(emptyHtml).toContain("No transfer or release receipts exist for this event");
    expect(emptyHtml).not.toContain("Dependency unavailable");
    expect(renderToStaticMarkup(createElement(SurfaceLoading, { label: "Program Builder" }))).toContain("Loading Program Builder");
    expect(renderToStaticMarkup(createElement(SurfaceNotFound, { label: "Program Builder" }))).toContain("cannot be disclosed");
    const errorHtml = renderToStaticMarkup(createElement(SurfaceError, { error: Object.assign(new Error("secret internal detail"), { digest: "correlation-123" }), reset: () => undefined, label: "Program Builder" }));
    expect(errorHtml).toContain("correlation-123");
    expect(errorHtml).not.toContain("secret internal detail");
  });

  it("keeps hostile stored policy values withheld through the real service seam", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const workspaceId = (db.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as { id: string }).id;
      const accountId = (db.prepare("SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer'").get(workspaceId) as { id: string }).id;
      const eventId = "ui-hostile-policy-event";
      const eventTime = "2026-09-15T09:00:00.000Z";
      db.prepare(`INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
        VALUES (?, ?, 'Hostile policy event', 'UTC', ?, '2026-09-15T10:00:00.000Z', '2026-08-10T00:00:00.000Z')`)
        .run(eventId, workspaceId, eventTime);
      db.prepare(`INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at)
        VALUES ('session-ui-hostile', 'token-ui-hostile', ?, ?, '2026-08-10T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`)
        .run(accountId, workspaceId);
      const session = {
        id: "session-ui-hostile", tokenHash: "token-ui-hostile", accountId, workspaceId,
        expiresAt: "2099-01-01T00:00:00.000Z", email: "organizer@northstar.example", displayName: "Northstar Organizer",
        role: "organizer" as const, workspaceSlug: "northstar", workspaceName: "Northstar Network",
      };
      createProgramCapacityPool(db, session, eventId, {
        poolId: "hostile-policy-pool", name: "Hostile policy pool", unitKind: "SEAT", capacity: 4,
        scope: { markup: "<script>alert('x')</script>" },
        eligibility: { handler: "<img src=x onerror=alert(1)>" },
        reservedFor: { secret: "<svg onload=alert(2)>" },
        releasePolicy: { rule: "javascript:alert(3)" }, effectiveFrom: eventTime,
      });
      const projection = getProgramCapacitySurfaceProjection(db, session, eventId);
      const html = renderToStaticMarkup(createElement(ProgramCapacityProjection, projection));
      expect(html).toContain("Details withheld from this projection");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("onerror");
      expect(html).not.toContain("javascript:alert");
      expect(html).not.toContain("markup");
    } finally {
      closeDb(db);
    }
  });
});
