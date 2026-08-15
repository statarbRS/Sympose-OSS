import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  cookieValue: undefined as string | undefined,
  revalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name === "sympose_session" && mocks.cookieValue
      ? { value: mocks.cookieValue }
      : undefined,
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/server/db")>("@/server/db");
  return { ...actual, getDb: vi.fn(() => mocks.db) };
});

import {
  addCrmPersonToEventAction,
  queueCrmBulkEmailAction,
  type CrmBulkEmailActionState,
  type CrmEventLinkActionState,
} from "@/app/w/[workspace]/crm/actions";
import { CrmConsole, type CrmEventSurface } from "@/components/crm/crm-console";
import { createSession } from "@/server/auth";
import { closeDb, openDb, type Db } from "@/server/db";
import { listManualSpeakerRecords } from "@/server/services/speaker-operations";
import { listSpeakerCommunicationDeliveryLog } from "@/server/services/speaker-communications";

const AT = "2026-08-12T12:00:00.000Z";
const WORKSPACE_A = "workspace-crm-a";
const WORKSPACE_B = "workspace-crm-b";
const EVENT_A = "event-crm-a";
const EVENT_A2 = "event-crm-a2";
const EVENT_B = "event-crm-b";
const PERSON_A = "person-crm-a";
const PERSON_A2 = "person-crm-a2";
const PERSON_B = "person-crm-b";
const ACCOUNT_A = "account-crm-organizer";
const IDLE_LINK: CrmEventLinkActionState = { kind: "idle" };
const IDLE_BULK: CrmBulkEmailActionState = { kind: "idle" };

interface Fixture {
  readonly db: Db;
  readonly organizerToken: string;
  readonly readOnlyToken: string;
}

function seedFixture(): Fixture {
  const db = openDb({ path: ":memory:", seed: false });
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(WORKSPACE_A, "alpha", "Alpha Workspace", AT);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(WORKSPACE_B, "bravo", "Bravo Workspace", AT);
  const insertEvent = db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, 'UTC', '2026-09-15T09:00:00.000Z', '2026-09-16T17:00:00.000Z', 'planning', ?)`,
  );
  insertEvent.run(EVENT_A, WORKSPACE_A, "Alpha Forum", AT);
  insertEvent.run(EVENT_A2, WORKSPACE_A, "Alpha Summit", AT);
  insertEvent.run(EVENT_B, WORKSPACE_B, "Bravo Forum", AT);
  const insertAccount = db.prepare(
    `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertAccount.run(ACCOUNT_A, WORKSPACE_A, "organizer@example.test", "Alpha Organizer", "organizer", AT);
  insertAccount.run("account-crm-read-only", WORKSPACE_A, "reader@example.test", "Read Only", "read_only", AT);
  insertAccount.run("account-crm-bravo", WORKSPACE_B, "bravo@example.test", "Bravo Organizer", "organizer", AT);
  const insertPerson = db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertPerson.run(PERSON_A, WORKSPACE_A, "Ada@Example.Test", "Ada Lovelace", "Analytical Engines", "Research Director", AT);
  insertPerson.run(PERSON_A2, WORKSPACE_A, "grace@example.test", "Grace Hopper", "Compiler Guild", "Admiral", AT);
  insertPerson.run(PERSON_B, WORKSPACE_B, "foreign@example.test", "Foreign Person", "Bravo", "Visitor", AT);
  return {
    db,
    organizerToken: createSession(db, ACCOUNT_A, WORKSPACE_A).token,
    readOnlyToken: createSession(db, "account-crm-read-only", WORKSPACE_A).token,
  };
}

function linkForm(
  personId = PERSON_A,
  eventId = EVENT_A,
  idempotencyKey = "crm-link-alpha-ada",
  workspace = "alpha",
): FormData {
  const form = new FormData();
  form.set("workspace", workspace);
  form.set("eventId", eventId);
  form.set("personId", personId);
  form.set("idempotencyKey", idempotencyKey);
  form.set("email", "attacker@example.test");
  form.set("fullName", "Caller Supplied Name");
  return form;
}

function bulkForm({
  personIds = [PERSON_A],
  eventId = EVENT_A,
  idempotencyKey = "crm-bulk-alpha-1",
  subject = "Update for {{eventName}}",
  body = "Hi {{firstName}},\n\nWelcome to {{eventName}}.",
  workspace = "alpha",
}: {
  readonly personIds?: readonly string[];
  readonly eventId?: string;
  readonly idempotencyKey?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly workspace?: string;
} = {}): FormData {
  const form = new FormData();
  form.set("workspace", workspace);
  form.set("eventId", eventId);
  form.set("idempotencyKey", idempotencyKey);
  form.set("subjectTemplate", subject);
  form.set("bodyTemplate", body);
  for (const personId of personIds) form.append("personId", personId);
  form.set("email", "attacker@example.test");
  form.set("displayName", "Caller Supplied Name");
  return form;
}

function domainCounts(db: Db): {
  readonly people: number;
  readonly eventSpeakers: number;
  readonly sourceRecords: number;
  readonly sourceLinks: number;
  readonly domainEvents: number;
  readonly outbox: number;
} {
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    people: count("people"),
    eventSpeakers: count("event_speakers"),
    sourceRecords: count("source_records"),
    sourceLinks: count("source_links"),
    domainEvents: count("domain_events"),
    outbox: count("outbox_messages"),
  };
}

function organizerScope(eventId = EVENT_A) {
  return { kind: "organizer" as const, workspaceId: WORKSPACE_A, eventId, actorId: ACCOUNT_A };
}

let fixture: Fixture;

beforeEach(() => {
  fixture = seedFixture();
  mocks.db = fixture.db;
  mocks.cookieValue = fixture.organizerToken;
  mocks.revalidatePath.mockReset();
});

afterEach(() => {
  closeDb(fixture.db);
  mocks.db = null;
  mocks.cookieValue = undefined;
});

describe("CRM-10 persistent canonical Person event linking", () => {
  it("links the existing normalized Person as PENDING/SPEAKER, survives reload, and replays without duplication", async () => {
    const before = domainCounts(fixture.db);
    const first = await addCrmPersonToEventAction(IDLE_LINK, linkForm());

    expect(first).toMatchObject({
      kind: "success",
      code: "CRM_EVENT_SPEAKER_LINKED",
      person: { id: PERSON_A, fullName: "Ada Lovelace", email: "Ada@Example.Test" },
      event: { id: EVENT_A, name: "Alpha Forum" },
      roleKey: "SPEAKER",
      participationStatus: "PENDING",
      replayed: false,
    });
    expect(first.kind === "success" ? first.message : "").toContain("No invitation, registration, attendance, or email is claimed");
    expect(domainCounts(fixture.db)).toMatchObject({
      people: before.people,
      eventSpeakers: before.eventSpeakers + 1,
      sourceRecords: before.sourceRecords + 1,
      sourceLinks: before.sourceLinks + 1,
      domainEvents: before.domainEvents + 1,
      outbox: before.outbox,
    });
    expect(fixture.db.prepare("SELECT person_id, role_key, participation_status FROM event_speakers WHERE workspace_id = ? AND event_id = ?").get(WORKSPACE_A, EVENT_A)).toEqual({
      person_id: PERSON_A,
      role_key: "SPEAKER",
      participation_status: "PENDING",
    });
    const reloaded = listManualSpeakerRecords(fixture.db, organizerScope());
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({ personId: PERSON_A, roleKey: "SPEAKER", participationStatus: "PENDING", canonicalIdentity: "Person" });

    const afterFirst = domainCounts(fixture.db);
    const replay = await addCrmPersonToEventAction(IDLE_LINK, linkForm());
    expect(replay).toMatchObject({ kind: "success", code: "CRM_EVENT_SPEAKER_REPLAYED", replayed: true });
    expect(domainCounts(fixture.db)).toEqual(afterFirst);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/w/alpha/crm");
  });

  it("rejects a stale request-key conflict with no relationship or evidence side effect", async () => {
    expect(await addCrmPersonToEventAction(IDLE_LINK, linkForm())).toMatchObject({ kind: "success" });
    fixture.db.prepare("UPDATE people SET full_name = ? WHERE id = ? AND workspace_id = ?").run("Ada Byron", PERSON_A, WORKSPACE_A);
    const beforeConflict = domainCounts(fixture.db);

    const conflict = await addCrmPersonToEventAction(IDLE_LINK, linkForm());

    expect(conflict).toMatchObject({ kind: "error", code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(domainCounts(fixture.db)).toEqual(beforeConflict);
  });

  it("denies missing auth, unprivileged/cross-workspace routes, foreign events, and foreign People without writes", async () => {
    const before = domainCounts(fixture.db);
    mocks.cookieValue = undefined;
    await expect(addCrmPersonToEventAction(IDLE_LINK, linkForm())).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_") });
    expect(domainCounts(fixture.db)).toEqual(before);

    mocks.cookieValue = fixture.readOnlyToken;
    await expect(addCrmPersonToEventAction(IDLE_LINK, linkForm())).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_") });
    expect(domainCounts(fixture.db)).toEqual(before);

    mocks.cookieValue = fixture.organizerToken;
    await expect(addCrmPersonToEventAction(IDLE_LINK, linkForm(PERSON_A, EVENT_A, "cross-workspace", "bravo"))).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_") });
    expect(domainCounts(fixture.db)).toEqual(before);

    expect(await addCrmPersonToEventAction(IDLE_LINK, linkForm(PERSON_A, EVENT_B, "foreign-event"))).toMatchObject({ kind: "error", code: "WORKSPACE_EVENT_NOT_FOUND" });
    expect(await addCrmPersonToEventAction(IDLE_LINK, linkForm(PERSON_B, EVENT_A, "foreign-person"))).toMatchObject({ kind: "error", code: "PERSON_NOT_IN_EVENT" });
    expect(domainCounts(fixture.db)).toEqual(before);
  });
});

describe("CRM-11 bounded durable local bulk email", () => {
  async function linkBothPeople(): Promise<void> {
    expect(await addCrmPersonToEventAction(IDLE_LINK, linkForm(PERSON_A, EVENT_A, "link-ada"))).toMatchObject({ kind: "success" });
    expect(await addCrmPersonToEventAction(IDLE_LINK, linkForm(PERSON_A2, EVENT_A, "link-grace"))).toMatchObject({ kind: "success" });
  }

  it("re-reads canonical recipients, stores rendered PENDING rows, survives reload, and replays exactly", async () => {
    await linkBothPeople();
    const beforeQueue = domainCounts(fixture.db);
    const form = bulkForm({ personIds: [PERSON_A, PERSON_A2] });

    const first = await queueCrmBulkEmailAction(IDLE_BULK, form);

    expect(first).toMatchObject({
      kind: "success",
      code: "CRM_BULK_EMAIL_QUEUED",
      recipientCount: 2,
      replayed: false,
      channel: "local",
      providerMutation: false,
    });
    if (first.kind !== "success") throw new Error("expected queued CRM batch");
    expect(first.message).toContain("PENDING");
    expect(first.message).toContain("Nothing was sent");
    expect(first.messages).toEqual([
      expect.objectContaining({ personId: PERSON_A, displayName: "Ada Lovelace", normalizedEmail: "ada@example.test", subject: "Update for Alpha Forum", body: "Hi Ada,\n\nWelcome to Alpha Forum.", status: "PENDING" }),
      expect.objectContaining({ personId: PERSON_A2, displayName: "Grace Hopper", normalizedEmail: "grace@example.test", subject: "Update for Alpha Forum", body: "Hi Grace,\n\nWelcome to Alpha Forum.", status: "PENDING" }),
    ]);
    expect(domainCounts(fixture.db)).toMatchObject({
      domainEvents: beforeQueue.domainEvents + 1,
      outbox: beforeQueue.outbox + 2,
    });
    const storedPayload = JSON.parse((fixture.db.prepare("SELECT payload_json FROM outbox_messages ORDER BY created_at, rowid LIMIT 1").get() as { payload_json: string }).payload_json) as {
      recipient: { displayName: string; normalizedEmail: string };
      renderedPreview: { subject: string; body: string };
      providerMutation: boolean;
    };
    expect(storedPayload).toMatchObject({
      recipient: { displayName: "Ada Lovelace", normalizedEmail: "ada@example.test" },
      renderedPreview: { subject: "Update for Alpha Forum", body: "Hi Ada,\n\nWelcome to Alpha Forum." },
      providerMutation: false,
    });
    expect(storedPayload.recipient.displayName).not.toBe("Caller Supplied Name");
    const reloaded = listSpeakerCommunicationDeliveryLog(fixture.db, { workspaceId: WORKSPACE_A, eventId: EVENT_A });
    expect(reloaded).toHaveLength(2);
    expect(reloaded.every((entry) => entry.status === "PENDING" && entry.channel === "local" && entry.providerMutation === false)).toBe(true);

    const afterFirst = domainCounts(fixture.db);
    const replay = await queueCrmBulkEmailAction(IDLE_BULK, bulkForm({ personIds: [PERSON_A, PERSON_A2] }));
    expect(replay).toMatchObject({ kind: "success", code: "CRM_BULK_EMAIL_REPLAYED", replayed: true });
    expect(replay.kind === "success" ? replay.messages.map((message) => message.messageId) : []).toEqual(first.messages.map((message) => message.messageId));
    expect(domainCounts(fixture.db)).toEqual(afterFirst);
  });

  it("rejects conflict, header injection, recipient overflow, and selected-event scope with zero queue side effects", async () => {
    await linkBothPeople();
    expect(await queueCrmBulkEmailAction(IDLE_BULK, bulkForm())).toMatchObject({ kind: "success" });
    const beforeDenied = domainCounts(fixture.db);

    expect(await queueCrmBulkEmailAction(IDLE_BULK, bulkForm({ subject: "Changed subject" }))).toMatchObject({ kind: "error", code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(await queueCrmBulkEmailAction(IDLE_BULK, bulkForm({ idempotencyKey: "header-injection", subject: "Update\r\nBcc: attacker@example.test" }))).toMatchObject({ kind: "error", code: "CONTROL_CHARACTER_REJECTED" });
    expect(await queueCrmBulkEmailAction(IDLE_BULK, bulkForm({ idempotencyKey: "wrong-event", eventId: EVENT_A2 }))).toMatchObject({ kind: "error", code: "PERSON_NOT_AUTHORIZED" });
    expect(await queueCrmBulkEmailAction(IDLE_BULK, bulkForm({ idempotencyKey: "too-many", personIds: Array.from({ length: 101 }, (_, index) => `bounded-person-${index}`) }))).toMatchObject({ kind: "error", code: "INVALID_INPUT" });
    expect(domainCounts(fixture.db)).toEqual(beforeDenied);
  });

  it("rejects unlinked/foreign recipients and normalized duplicate destinations before outbox writes", async () => {
    const beforeUnlinked = domainCounts(fixture.db);
    expect(await queueCrmBulkEmailAction(IDLE_BULK, bulkForm({ personIds: [PERSON_A], idempotencyKey: "unlinked" }))).toMatchObject({ kind: "error", code: "PERSON_NOT_AUTHORIZED" });
    expect(await queueCrmBulkEmailAction(IDLE_BULK, bulkForm({ personIds: [PERSON_B], idempotencyKey: "foreign" }))).toMatchObject({ kind: "error", code: "PERSON_NOT_AUTHORIZED" });
    expect(domainCounts(fixture.db)).toEqual(beforeUnlinked);

    const insertPerson = fixture.db.prepare(
      `INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    );
    insertPerson.run("person-duplicate-lower", WORKSPACE_A, "duplicate@example.test", "Duplicate Lower", AT);
    insertPerson.run("person-duplicate-upper", WORKSPACE_A, "DUPLICATE@example.test", "Duplicate Upper", AT);
    const insertSpeaker = fixture.db.prepare(
      `INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'SPEAKER', 'PENDING', ?, ?)`,
    );
    insertSpeaker.run("speaker-duplicate-lower", WORKSPACE_A, EVENT_A, "person-duplicate-lower", AT, AT);
    insertSpeaker.run("speaker-duplicate-upper", WORKSPACE_A, EVENT_A, "person-duplicate-upper", AT, AT);
    const beforeDuplicate = domainCounts(fixture.db);

    const duplicate = await queueCrmBulkEmailAction(IDLE_BULK, bulkForm({
      personIds: ["person-duplicate-lower", "person-duplicate-upper"],
      idempotencyKey: "normalized-duplicate",
    }));

    expect(duplicate).toMatchObject({ kind: "error", code: "DUPLICATE_RECIPIENT" });
    expect(domainCounts(fixture.db)).toEqual(beforeDuplicate);
  });

  it("denies missing auth, unprivileged/cross-workspace routes, and foreign events without outbox writes", async () => {
    const before = domainCounts(fixture.db);
    mocks.cookieValue = undefined;
    await expect(queueCrmBulkEmailAction(IDLE_BULK, bulkForm())).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_") });
    expect(domainCounts(fixture.db)).toEqual(before);

    mocks.cookieValue = fixture.readOnlyToken;
    await expect(queueCrmBulkEmailAction(IDLE_BULK, bulkForm())).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_") });
    expect(domainCounts(fixture.db)).toEqual(before);

    mocks.cookieValue = fixture.organizerToken;
    await expect(queueCrmBulkEmailAction(IDLE_BULK, bulkForm({ workspace: "bravo" }))).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_") });
    expect(await queueCrmBulkEmailAction(IDLE_BULK, bulkForm({ eventId: EVENT_B, idempotencyKey: "foreign-event" }))).toMatchObject({
      kind: "error",
      code: "WORKSPACE_EVENT_NOT_FOUND",
    });
    expect(domainCounts(fixture.db)).toEqual(before);
  });
});

describe("CRM-10/11 browser-visible evidence", () => {
  it("renders event selection, canonical linking, bounded queue controls, rendered content, and reload-safe queued-not-sent evidence", () => {
    const events: readonly CrmEventSurface[] = [{
      id: EVENT_A,
      name: "Alpha Forum",
      lifecycle: "planning",
      memberships: [{ personId: PERSON_A, roleKey: "SPEAKER", participationStatus: "PENDING", updatedAt: AT }],
      history: [{
        messageId: "message-crm-a",
        domainEventId: "batch-crm-a",
        workspaceId: WORKSPACE_A,
        eventId: EVENT_A,
        personId: PERSON_A,
        normalizedEmail: "ada@example.test",
        displayName: "Ada Lovelace",
        destinationKey: "local:speaker-communication:event-crm-a:person-crm-a:fixture",
        templateKey: "speaker-bulk-local-v1",
        subjectPreview: "Update for Alpha Forum",
        bodyPreview: "Hi Ada,\n\nWelcome to Alpha Forum.",
        payloadFingerprint: "fixture-fingerprint",
        status: "PENDING",
        attemptCount: 0,
        nextAttemptAt: AT,
        createdAt: AT,
        deliveredAt: null,
        channel: "local",
        providerMutation: false,
      }],
      nextCommunicationIdempotencyKey: "crm-bulk:event-crm-a:1",
      linkIdempotencyKeys: { [PERSON_A]: "crm-link-person-a", [PERSON_A2]: "crm-link-person-a2" },
      maxRecipients: 100,
    }];
    const html = renderToStaticMarkup(createElement(CrmConsole, {
      workspaceSlug: "alpha",
      workspaceName: "Alpha Workspace",
      people: [
        { id: PERSON_A, canonicalEmail: "Ada@Example.Test", fullName: "Ada Lovelace", organization: "Analytical Engines", title: "Research Director", sourceCount: 1 },
        { id: PERSON_A2, canonicalEmail: "grace@example.test", fullName: "Grace Hopper", organization: "Compiler Guild", title: "Admiral", sourceCount: 1 },
      ],
      metrics: { totalPeople: 2, organizations: 2, withOrganization: 2, withTitle: 2, sourcedPeople: 2 },
      events,
    }));

    expect(html).toContain('data-testid="crm-event-actions"');
    expect(html).toContain("Selected event");
    expect(html).toContain('data-testid="crm-event-link-form"');
    expect(html).toContain("Add as pending speaker");
    expect(html).toContain("does not create a contact copy");
    expect(html).toContain("It does not create a contact copy or imply an invitation, registration, commitment, or attendance");
    expect(html).toContain('data-testid="crm-bulk-email-form"');
    expect(html).toContain("maximum 100");
    expect(html).toContain('name="personId" value="person-crm-a"');
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain('name="displayName"');
    expect(html).toContain("Rendered preview");
    expect(html).toContain("No email provider is connected");
    expect(html).toContain('data-testid="crm-email-queue-history"');
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("ada@example.test");
    expect(html).toContain("Update for Alpha Forum");
    expect(html).toContain("Welcome to Alpha Forum");
    expect(html).toContain("QUEUED · PENDING");
    expect(html).toContain("Not sent · provider mutation false");
    expect(html).toContain("Event speaker links and PENDING local outbox evidence persist");
  });
});
