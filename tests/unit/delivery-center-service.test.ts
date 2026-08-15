import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "@/server/auth";
import { closeDb, openDb, type Db } from "@/server/db";
import { seedWorkspaces } from "@/server/seed";
import {
  createDeliveryCenterReader,
  DeliveryCenterAuthorizationError,
  DeliveryCenterNotFoundError,
  readDeliveryCenter,
  type DeliveryCenterSourceLoaders,
} from "@/server/services/delivery-center";

const CREATED_AT = "2026-08-13T01:00:00.000Z";
const EVENT_STARTS_AT = "2026-09-18T09:00:00.000Z";
const EVENT_ENDS_AT = "2026-09-18T17:00:00.000Z";

const databases = new Set<Db>();
const temporaryDirectories = new Set<string>();

interface Fixture {
  readonly db: Db;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly accountId: string;
  readonly eventId: string;
  readonly session: SessionInfo;
}

function setup(path = ":memory:"): Fixture {
  const db = openDb({ path, seed: false });
  databases.add(db);
  seedWorkspaces(db);
  const workspace = db.prepare(
    "SELECT id, slug, name FROM workspaces WHERE slug = 'northstar'",
  ).get() as { readonly id: string; readonly slug: string; readonly name: string };
  const account = db.prepare(
    "SELECT id, email, display_name AS displayName, role FROM accounts WHERE workspace_id = ?",
  ).get(workspace.id) as {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: string;
  };
  const eventId = "delivery-center-event";
  db.prepare(
    `INSERT OR IGNORE INTO events
       (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, 'Delivery Evidence Forum', 'UTC', ?, ?, 'planning', ?)`,
  ).run(eventId, workspace.id, EVENT_STARTS_AT, EVENT_ENDS_AT, CREATED_AT);
  const session: SessionInfo = {
    id: "delivery-center-session",
    tokenHash: "delivery-center-token-hash",
    accountId: account.id,
    workspaceId: workspace.id,
    expiresAt: "2099-01-01T00:00:00.000Z",
    email: account.email,
    displayName: account.displayName,
    role: account.role,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.name,
  };
  return {
    db,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.name,
    accountId: account.id,
    eventId,
    session,
  };
}

function closeTracked(db: Db): void {
  if (databases.delete(db)) closeDb(db);
}

function speakerRow(fixture: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const selectedStatus = overrides.status ?? "PENDING";
  return {
    messageId: "speaker-message-1",
    domainEventId: "speaker-domain-event-1",
    workspaceId: fixture.workspaceId,
    eventId: fixture.eventId,
    personId: "speaker-person-1",
    normalizedEmail: "speaker@example.test",
    displayName: "Speaker One",
    destinationKey: "local:speaker-communication:delivery-center-event:speaker-person-1:one",
    templateKey: "speaker-bulk-local-v1",
    subjectPreview: "Speaker update",
    bodyPreview: "Hello Speaker One,\n\nThis is a local rendered message.",
    payloadFingerprint: "a".repeat(64),
    status: selectedStatus,
    attemptCount: selectedStatus === "PENDING" ? 0 : 1,
    nextAttemptAt: selectedStatus === "FAILED" ? "2026-08-13T01:05:00.000Z" : null,
    createdAt: CREATED_AT,
    deliveredAt: selectedStatus === "DELIVERED" ? "2026-08-13T01:02:00.000Z" : null,
    channel: "local",
    providerMutation: false,
    ...overrides,
  };
}

function reminderRow(fixture: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "reminder-message-1",
    domainEventId: "reminder-domain-event-1",
    workspaceId: fixture.workspaceId,
    eventId: fixture.eventId,
    definitionId: "reminder-definition-1",
    taskId: "reminder-task-1",
    assignmentId: "reminder-assignment-1",
    recipientPersonId: "reminder-person-1",
    recipientName: "Reminder Recipient",
    recipientEmail: "reminder@example.test",
    occurrenceDate: "2026-08-13",
    eventName: "Delivery Evidence Forum",
    taskTitle: "Confirm arrival",
    taskInstructions: "Confirm your arrival window.",
    dueDate: "2026-08-15",
    dueAt: "2026-08-15T23:59:59.999Z",
    subjectPreview: "Action due: Confirm arrival",
    bodyPreview: "Delivery Evidence Forum\n\nConfirm arrival\nDue 2026-08-15 UTC\n\nConfirm your arrival window.",
    destinationKey: "local:speaker-action-task-reminder:delivery-center-event:reminder-task-1:2026-08-13",
    payloadFingerprint: "b".repeat(64),
    status: "FAILED",
    attemptCount: 3,
    nextAttemptAt: "2026-08-13T01:10:00.000Z",
    createdAt: CREATED_AT,
    deliveredAt: null,
    lastErrorRecorded: true,
    providerReceiptId: null,
    providerAcceptedAt: null,
    deliveryMode: null,
    channel: "local",
    providerMutation: false,
    ...overrides,
  };
}

function cfpRow(fixture: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const communication = {
    evidenceVersion: "rendered-v2",
    receiptId: "cfp-receipt-1",
    decisionEventId: "cfp-decision-1",
    status: "PENDING",
    channel: "local-inbox-simulation",
    recipientPersonId: "cfp-person-1",
    recipientDisplayName: "CFP Applicant",
    recipientEmail: "applicant@example.test",
    templateKey: "cfp-decision-accepted-v1",
    mergeValues: {
      eventName: "Delivery Evidence Forum",
      callName: "Main call",
      proposalTitle: "Evidence without invention",
    },
    renderedSubject: "Delivery Evidence Forum — Main call: Evidence without invention accepted",
    renderedBody: "Hello CFP Applicant,\n\nYour proposal was accepted. This is queued only in the local inbox simulation.",
    payloadFingerprint: "c".repeat(64),
    queuedAt: "2026-08-13T01:01:00.000Z",
    simulated: true,
    providerMutation: false,
    message: "Local simulation only.",
  };
  return {
    workspaceId: fixture.workspaceId,
    eventId: fixture.eventId,
    decision: "ACCEPTED",
    communication,
    ...overrides,
  };
}

function loaders(
  fixture: Fixture,
  overrides: Partial<DeliveryCenterSourceLoaders> = {},
): DeliveryCenterSourceLoaders {
  return {
    speakerCommunications: vi.fn(() => [speakerRow(fixture)]),
    sharedTaskReminders: vi.fn(() => [reminderRow(fixture)]),
    cfpDecisionNotices: vi.fn(() => [cfpRow(fixture)]),
    ...overrides,
  };
}

function read(fixture: Fixture, sourceLoaders = loaders(fixture)) {
  return createDeliveryCenterReader(sourceLoaders)(fixture.db, fixture.session, {
    workspaceSlug: fixture.workspaceSlug,
    eventId: fixture.eventId,
  });
}

afterEach(() => {
  for (const db of [...databases]) closeTracked(db);
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe("Delivery Center authorized read model", () => {
  it("composes the real typed loaders into a truthful empty projection without creating state", () => {
    const fixture = setup();
    const before = {
      domainEvents: fixture.db.prepare("SELECT COUNT(*) AS count FROM domain_events").get(),
      outbox: fixture.db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get(),
    };

    const projection = readDeliveryCenter(fixture.db, fixture.session, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
    });

    expect(projection.items).toEqual([]);
    expect(projection.summary).toEqual({ total: 0, pending: 0, claimed: 0, delivered: 0, failed: 0 });
    expect(projection.sources.map((source) => [source.key, source.state])).toEqual([
      ["SPEAKER_COMMUNICATIONS", "EMPTY"],
      ["SHARED_TASK_REMINDERS", "EMPTY"],
      ["CFP_DECISION_NOTICES", "EMPTY"],
      ["CONTENT_NOTIFICATIONS", "UNAVAILABLE"],
    ]);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual(before.domainEvents);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual(before.outbox);
  });

  it("normalizes only typed scoped projections and preserves local status, attempts, and timestamps", () => {
    const fixture = setup();
    const sources = loaders(fixture, {
      speakerCommunications: vi.fn(() => [
        speakerRow(fixture, { messageId: "speaker-claimed", status: "CLAIMED" }),
        speakerRow(fixture, { messageId: "speaker-delivered", status: "DELIVERED" }),
      ]),
    });
    const before = {
      domainEvents: fixture.db.prepare("SELECT COUNT(*) AS count FROM domain_events").get(),
      outbox: fixture.db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get(),
    };

    const projection = read(fixture, sources);

    expect(projection).toMatchObject({
      schema: "sympose-delivery-center/v1",
      workspace: { id: fixture.workspaceId, slug: "northstar", name: fixture.workspaceName },
      event: { id: fixture.eventId, name: "Delivery Evidence Forum", timezone: "UTC" },
      readOnly: true,
      providerContacted: false,
      smtpContacted: false,
      summary: { total: 4, pending: 1, claimed: 1, delivered: 1, failed: 1 },
    });
    expect(projection.items.map((item) => item.source)).toEqual([
      "CFP_DECISION_NOTICES",
      "SHARED_TASK_REMINDERS",
      "SPEAKER_COMMUNICATIONS",
      "SPEAKER_COMMUNICATIONS",
    ]);
    expect(projection.items.find((item) => item.id === "shared-task:reminder-message-1")).toMatchObject({
      status: "FAILED",
      attemptCount: 3,
      nextAttemptAt: "2026-08-13T01:10:00.000Z",
      deliveredAt: null,
      failureRecorded: true,
      recipient: { displayName: "Reminder Recipient", email: "reminder@example.test" },
      subject: "Action due: Confirm arrival",
    });
    expect(projection.items.find((item) => item.id === "cfp:cfp-receipt-1")).toMatchObject({
      status: "PENDING",
      attemptCount: null,
      nextAttemptAt: null,
      deliveredAt: null,
      channel: "local-inbox-simulation",
    });
    expect(projection.sources.at(-1)).toMatchObject({
      key: "CONTENT_NOTIFICATIONS",
      state: "UNAVAILABLE",
      itemCount: 0,
    });
    expect(projection.sources.at(-1)?.disclosure).toContain("Generic outbox payloads are deliberately not read");
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.items)).toBe(true);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual(before.domainEvents);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual(before.outbox);
  });

  it("exposes a bound no-network reminder receipt without claiming SMTP or provider delivery", () => {
    const fixture = setup();
    const projection = read(fixture, loaders(fixture, {
      speakerCommunications: vi.fn(() => []),
      sharedTaskReminders: vi.fn(() => [reminderRow(fixture, {
        messageId: "reminder-delivered-1",
        status: "DELIVERED",
        attemptCount: 2,
        nextAttemptAt: null,
        deliveredAt: "2026-08-13T01:03:00.000Z",
        lastErrorRecorded: false,
        providerReceiptId: "no-network-receipt-1",
        providerAcceptedAt: "2026-08-13T01:03:00.000Z",
        deliveryMode: "NO_NETWORK_SIMULATED",
      })]),
      cfpDecisionNotices: vi.fn(() => []),
    }));

    expect(projection.summary).toEqual({ total: 1, pending: 0, claimed: 0, delivered: 1, failed: 0 });
    expect(projection.items[0]).toMatchObject({
      id: "shared-task:reminder-delivered-1",
      status: "DELIVERED",
      providerReceipt: {
        id: "no-network-receipt-1",
        acceptedAt: "2026-08-13T01:03:00.000Z",
        mode: "NO_NETWORK_SIMULATED",
      },
    });
    expect(projection.items[0]?.statusMeaning).toContain("durable no-network simulated adapter receipt");
    expect(projection.providerContacted).toBe(false);
    expect(projection.smtpContacted).toBe(false);
  });

  it.each(["reviewer", "read_only", "communications_manager"])(
    "denies a %s session before any delivery source read",
    (role) => {
      const fixture = setup();
      const sourceLoaders = loaders(fixture);
      expect(() => createDeliveryCenterReader(sourceLoaders)(fixture.db, {
        ...fixture.session,
        role,
      }, {
        workspaceSlug: fixture.workspaceSlug,
        eventId: fixture.eventId,
      })).toThrow(DeliveryCenterAuthorizationError);
      expect(sourceLoaders.speakerCommunications).not.toHaveBeenCalled();
      expect(sourceLoaders.sharedTaskReminders).not.toHaveBeenCalled();
      expect(sourceLoaders.cfpDecisionNotices).not.toHaveBeenCalled();
    },
  );

  it("fails closed for a foreign slug, missing persisted actor, and wrong workspace/event binding", () => {
    const fixture = setup();
    const sourceLoaders = loaders(fixture);
    const reader = createDeliveryCenterReader(sourceLoaders);
    expect(() => reader(fixture.db, fixture.session, {
      workspaceSlug: "acme",
      eventId: fixture.eventId,
    })).toThrow(DeliveryCenterAuthorizationError);
    expect(() => reader(fixture.db, { ...fixture.session, accountId: "missing-organizer" }, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: fixture.eventId,
    })).toThrow(DeliveryCenterAuthorizationError);

    const acme = fixture.db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { readonly id: string };
    fixture.db.prepare(
      `INSERT INTO events
         (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
       VALUES ('foreign-delivery-event', ?, 'Foreign event', 'UTC', ?, ?, 'planning', ?)`,
    ).run(acme.id, EVENT_STARTS_AT, EVENT_ENDS_AT, CREATED_AT);
    expect(() => reader(fixture.db, fixture.session, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: "foreign-delivery-event",
    })).toThrow(DeliveryCenterNotFoundError);
    expect(() => reader(fixture.db, fixture.session, {
      workspaceSlug: fixture.workspaceSlug,
      eventId: "missing-delivery-event",
    })).toThrow(DeliveryCenterNotFoundError);
    expect(sourceLoaders.speakerCommunications).not.toHaveBeenCalled();
  });

  it("drops each malformed or failed source with generic copy and never reflects extra payload fields", () => {
    const fixture = setup();
    const sourceLoaders = loaders(fixture, {
      speakerCommunications: vi.fn(() => [speakerRow(fixture, {
        eventId: "wrong-event",
        apiToken: "DO_NOT_EXPOSE_SPEAKER_TOKEN",
      })]),
      sharedTaskReminders: vi.fn(() => {
        throw new Error("DO_NOT_EXPOSE_PROVIDER_FAILURE");
      }),
      cfpDecisionNotices: vi.fn(() => [cfpRow(fixture, {
        communication: {
          ...(cfpRow(fixture).communication as Record<string, unknown>),
          providerMutation: true,
          authorizationHeader: "DO_NOT_EXPOSE_AUTHORIZATION",
        },
      })]),
    });

    const projection = read(fixture, sourceLoaders);
    expect(projection.items).toEqual([]);
    expect(projection.sources.slice(0, 3).map((source) => source.state)).toEqual(["ERROR", "ERROR", "ERROR"]);
    expect(projection.sources.slice(0, 3).every((source) => source.itemCount === 0)).toBe(true);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("DO_NOT_EXPOSE");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("provider failure");
    expect(serialized).not.toContain("wrong-event");
    expect(serialized).toContain("could not be validated");
  });

  it("rejects invalid local status and timestamp claims rather than inventing delivery evidence", () => {
    const fixture = setup();
    const projection = read(fixture, loaders(fixture, {
      speakerCommunications: vi.fn(() => [speakerRow(fixture, {
        status: "SENT",
        deliveredAt: "2026-08-13T01:02:00.000Z",
      })]),
      sharedTaskReminders: vi.fn(() => [reminderRow(fixture, {
        status: "DELIVERED",
        deliveredAt: null,
      })]),
    }));
    expect(projection.items.map((item) => item.source)).toEqual(["CFP_DECISION_NOTICES"]);
    expect(projection.sources.find((source) => source.key === "SPEAKER_COMMUNICATIONS")?.state).toBe("ERROR");
    expect(projection.sources.find((source) => source.key === "SHARED_TASK_REMINDERS")?.state).toBe("ERROR");
    expect(projection.summary).toEqual({ total: 1, pending: 1, claimed: 0, delivered: 0, failed: 0 });
  });

  it("is deterministic across repeated reads and a cold database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "sympose-delivery-center-"));
    temporaryDirectories.add(directory);
    const path = join(directory, "delivery-center.sqlite");
    const fixture = setup(path);
    const first = read(fixture);
    const repeated = read(fixture);
    expect(repeated).toEqual(first);

    closeTracked(fixture.db);
    const reopened = setup(path);
    const cold = read(reopened);
    expect(cold).toEqual(first);
    expect(cold.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
  });
});
