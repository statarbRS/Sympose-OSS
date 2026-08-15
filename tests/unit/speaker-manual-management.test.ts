import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, fingerprintOf } from "@/server/canonical";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  SPEAKER_COMMUNICATION_TEMPLATE_KEY,
  queueSpeakerCommunicationBatch,
} from "@/server/services/speaker-communications";
import {
  createManualSpeaker,
  editManualSpeaker,
  listManualSpeakerRecords,
  ManualSpeakerAuthorizationError,
  ManualSpeakerConflictError,
  ManualSpeakerError,
  ManualSpeakerInputError,
  manualSpeakerEditIdempotencyKey,
} from "@/server/services/speaker-operations";

const AT = "2026-01-01T00:00:00.000Z";
const WORKSPACE_A = "manual-workspace-a";
const WORKSPACE_B = "manual-workspace-b";
const ACCOUNT_A = "manual-account-a";
const ACCOUNT_B = "manual-account-b";
const EVENT_A = "manual-event-a";
const EVENT_A2 = "manual-event-a2";
const EVENT_B = "manual-event-b";

const scopeA = { kind: "organizer" as const, workspaceId: WORKSPACE_A, eventId: EVENT_A, actorId: ACCOUNT_A };
const scopeA2 = { ...scopeA, eventId: EVENT_A2 };
const scopeB = { kind: "organizer" as const, workspaceId: WORKSPACE_B, eventId: EVENT_B, actorId: ACCOUNT_B };

const databases: Db[] = [];
const databaseRoots: string[] = [];

function setup(path = ":memory:"): Db {
  const db = openDb({ path, seed: false });
  databases.push(db);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(WORKSPACE_A, "manual-a", "Manual A", AT);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(WORKSPACE_B, "manual-b", "Manual B", AT);
  db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, 'organizer', ?)").run(ACCOUNT_A, WORKSPACE_A, "organizer-a@example.test", "Organizer A", AT);
  db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, 'organizer', ?)").run(ACCOUNT_B, WORKSPACE_B, "organizer-b@example.test", "Organizer B", AT);
  const insertEvent = db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, 'UTC', ?, ?, ?)");
  insertEvent.run(EVENT_A, WORKSPACE_A, "Manual Event A", "2026-09-01T09:00:00.000Z", "2026-09-01T17:00:00.000Z", AT);
  insertEvent.run(EVENT_A2, WORKSPACE_A, "Manual Event A2", "2026-10-01T09:00:00.000Z", "2026-10-01T17:00:00.000Z", AT);
  insertEvent.run(EVENT_B, WORKSPACE_B, "Manual Event B", "2026-09-01T09:00:00.000Z", "2026-09-01T17:00:00.000Z", AT);
  return db;
}

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
  for (const root of databaseRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("organizer manual speaker management", () => {
  it("creates one canonical Person, event relationship, and immutable provenance atomically", () => {
    const db = setup();
    const result = createManualSpeaker(db, scopeA, {
      fullName: "  Taylor Example ",
      email: " TAYLOR@Example.Test ",
      title: "Staff Engineer",
      organization: "Example Labs",
      bio: "Builds reliable systems.\nEnjoys clear evidence.",
      idempotencyKey: "manual-create-1",
    });

    expect(result).toMatchObject({ createdPerson: true, createdEventSpeaker: true, linkedExistingPerson: false, replayed: false, deduped: false });
    expect(result.record).toMatchObject({
      email: "taylor@example.test",
      fullName: "Taylor Example",
      title: "Staff Engineer",
      organization: "Example Labs",
      bio: "Builds reliable systems.\nEnjoys clear evidence.",
      canonicalIdentity: "Person",
      emailPolicy: "read-only-after-create",
      participationStatus: "PENDING",
      canonicalPerson: { fullName: "Taylor Example", email: "taylor@example.test", authority: "workspace-person" },
      eventProfile: { title: "Staff Engineer", organization: "Example Labs", bio: "Builds reliable systems.\nEnjoys clear evidence.", authority: "event-scoped-manual-source" },
    });
    expect(count(db, "people")).toBe(1);
    expect(count(db, "event_speakers")).toBe(1);
    expect(count(db, "source_records")).toBe(1);
    expect(count(db, "source_links")).toBe(1);
    expect(count(db, "domain_events")).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT workspace_id, event_id, person_id, role_key FROM event_speakers").get() as Record<string, string>)).toMatchObject({ workspace_id: WORKSPACE_A, event_id: EVENT_A, person_id: result.record.personId, role_key: "SPEAKER" });
    const source = db.prepare("SELECT provider, source_ref, version, payload_json FROM source_records").get() as { provider: string; source_ref: string; version: number; payload_json: string };
    expect(source).toMatchObject({ provider: "organizer-manual", source_ref: `manual-speaker:${EVENT_A}:${result.record.personId}`, version: 1 });
    expect(JSON.parse(source.payload_json)).toMatchObject({ schema: "sympose-manual-speaker-profile/v1", eventId: EVENT_A, personId: result.record.personId, bio: "Builds reliable systems.\nEnjoys clear evidence." });
  });

  it("projects only durable delivery evidence and keeps adopted relationships explicitly bounded", () => {
    const db = setup();
    db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("adopted-person", WORKSPACE_A, "adopted@example.test", "Adopted Speaker", "Legacy Org", "Legacy Title", AT);
    db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'SPEAKER', 'INVITED', ?, ?)").run("adopted-event-link", WORKSPACE_A, EVENT_A, "adopted-person", AT, AT);

    const adopted = listManualSpeakerRecords(db, scopeA)[0]!;
    expect(adopted).toMatchObject({
      participationStatus: "INVITED",
      participationStatusTrust: "TRUSTED",
      managementState: "UNVERIFIED_EVENT_RELATION",
      organization: "",
      title: "",
      bio: "",
      eventProfile: { authority: "unverified-event-relation" },
      deliveryEvidence: { source: "no-durable-evidence", state: "NO_DURABLE_EVIDENCE", messageIds: [], latestAt: null },
    });

    const adoptedIntoManual = createManualSpeaker(db, scopeA, { fullName: "Adopted Speaker", email: "adopted@example.test" });
    expect(adoptedIntoManual.record.managementState).toBe("MANUAL_PROVENANCE");
    expect(adoptedIntoManual.record.participationStatus).toBe("INVITED");
    expect(adoptedIntoManual.record.deliveryEvidence.state).toBe("NO_DURABLE_EVIDENCE");
    expect((db.prepare("SELECT participation_status FROM event_speakers WHERE id = ?").get("adopted-event-link") as { participation_status: string }).participation_status).toBe("INVITED");

    const pending = createManualSpeaker(db, scopeA, { fullName: "Pending Speaker", email: "pending@example.test" });
    expect(pending.record.participationStatus).toBe("PENDING");
    expect(pending.record.deliveryEvidence.state).toBe("NO_DURABLE_EVIDENCE");
    const receipt = queueSpeakerCommunicationBatch(db, {
      workspaceId: WORKSPACE_A,
      eventId: EVENT_A,
      idempotencyKey: "manual-delivery-evidence",
      templateKey: SPEAKER_COMMUNICATION_TEMPLATE_KEY,
      subjectTemplate: "Invitation for {{displayName}}",
      bodyTemplate: "Hello {{displayName}}",
      recipients: [{ personId: pending.record.personId, email: pending.record.email, displayName: pending.record.fullName }],
    });
    const withDelivery = listManualSpeakerRecords(db, scopeA).find((record) => record.personId === pending.record.personId)!;
    expect(withDelivery.deliveryEvidence).toMatchObject({ source: "durable-outbox", state: "PENDING", messageIds: [receipt.messageIds[0]], latestAt: expect.any(String) });
  });

  it("links an existing workspace Person to another event without copying identities or relations", () => {
    const db = setup();
    db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("existing-person", WORKSPACE_A, "existing@example.test", "Existing Person", "Existing Org", "Existing Title", AT);
    db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'SPEAKER', 'INVITED', ?, ?)").run("existing-event-link", WORKSPACE_A, EVENT_A2, "existing-person", AT, AT);

    const result = createManualSpeaker(db, scopeA, {
      fullName: "Existing Person",
      email: "EXISTING@example.test",
    });

    expect(result).toMatchObject({ createdPerson: false, createdEventSpeaker: true, linkedExistingPerson: true });
    expect(result.record).toMatchObject({ personId: "existing-person", title: "", organization: "", bio: "", managementState: "MANUAL_PROVENANCE" });
    expect(count(db, "people")).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM event_speakers WHERE workspace_id = ? AND person_id = ?").get(WORKSPACE_A, "existing-person") as { count: number }).count).toBe(2);
    expect(listManualSpeakerRecords(db, scopeA).map((record) => record.eventId)).toEqual([EVENT_A]);
    expect(listManualSpeakerRecords(db, scopeA2).map((record) => record.eventId)).toEqual([EVENT_A2]);
    expect(db.prepare("SELECT source_ref FROM source_records ORDER BY source_ref").all().map((row) => (row as { source_ref: string }).source_ref)).toEqual([
      `manual-speaker:${EVENT_A}:existing-person`,
    ]);
  });

  it("adds the requested speaker role beside an existing moderator relation without duplicating the Person", () => {
    const db = setup();
    db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("moderator-person", WORKSPACE_A, "moderator@example.test", "Moderator Person", null, null, AT);
    db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'MODERATOR', 'INVITED', ?, ?)").run("moderator-event-link", WORKSPACE_A, EVENT_A, "moderator-person", AT, AT);

    const result = createManualSpeaker(db, scopeA, { fullName: "Moderator Person", email: "moderator@example.test" });

    expect(result).toMatchObject({ createdPerson: false, createdEventSpeaker: true, linkedExistingPerson: true, record: { roleKey: "SPEAKER" } });
    expect(count(db, "people")).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM event_speakers WHERE workspace_id = ? AND event_id = ? AND person_id = ?").get(WORKSPACE_A, EVENT_A, "moderator-person") as { count: number }).count).toBe(2);
    expect(listManualSpeakerRecords(db, scopeA).map((record) => record.roleKey)).toEqual(["SPEAKER"]);
  });

  it("replays by idempotency and deduplicates normalized email without creating a shadow speaker", () => {
    const db = setup();
    const input = { fullName: "Replay Person", email: "Replay@Example.Test", title: "Researcher", organization: "Replay Org", bio: "Same profile", idempotencyKey: "replay-1" };
    const first = createManualSpeaker(db, scopeA, input);
    const replay = createManualSpeaker(db, scopeA, input);
    const deduped = createManualSpeaker(db, scopeA, { ...input, email: " replay@example.test ", idempotencyKey: undefined });

    expect(replay).toEqual({ ...first, replayed: true, deduped: false });
    expect(deduped).toMatchObject({ record: first.record, createdPerson: false, createdEventSpeaker: false, replayed: false, deduped: true });
    expect(count(db, "people")).toBe(1);
    expect(count(db, "event_speakers")).toBe(1);
    expect(count(db, "source_records")).toBe(1);
    expect(count(db, "domain_events")).toBe(1);

    const noOpInput = { ...input, idempotencyKey: "replay-noop-create" };
    const noOp = createManualSpeaker(db, scopeA, noOpInput);
    const noOpReplay = createManualSpeaker(db, scopeA, noOpInput);
    expect(noOp).toMatchObject({ record: first.record, createdPerson: false, createdEventSpeaker: false, replayed: false, deduped: true });
    expect(noOpReplay).toEqual({ ...noOp, replayed: true, deduped: false });
    expect(() => createManualSpeaker(db, scopeA, { ...noOpInput, email: "different@example.test" })).toThrow(ManualSpeakerConflictError);
    expect(count(db, "domain_events")).toBe(2);
    expect(() => createManualSpeaker(db, scopeA, { ...input, fullName: "Different Person", idempotencyKey: "replay-conflict" })).toThrow(ManualSpeakerConflictError);
    expect(count(db, "people")).toBe(1);
    expect(count(db, "event_speakers")).toBe(1);
  });

  it("edits bounded profile metadata, preserves email, appends provenance, and survives a database reload", () => {
    const root = mkdtempSync(join(tmpdir(), "sympose-manual-speakers-"));
    databaseRoots.push(root);
    const path = join(root, "manual.db");
    const db = setup(path);
    const created = createManualSpeaker(db, scopeA, { fullName: "Before Edit", email: "before@example.test", title: "Old title", organization: "Old org", bio: "Old bio", idempotencyKey: "edit-create" });
    const edited = editManualSpeaker(db, scopeA, {
      personId: created.record.personId,
      expectedEmail: "BEFORE@EXAMPLE.TEST",
      expectedFullName: "Before Edit",
      fullName: "After Edit",
      title: "New title",
      organization: "New org",
      bio: "New bio",
      idempotencyKey: "edit-1",
    });

    expect(edited.record).toMatchObject({ fullName: "After Edit", email: "before@example.test", title: "New title", organization: "New org", bio: "New bio" });
    expect((db.prepare("SELECT canonical_email, full_name, title, organization FROM people WHERE id = ?").get(created.record.personId) as Record<string, string>)).toEqual({ canonical_email: "before@example.test", full_name: "After Edit", title: "Old title", organization: "Old org" });
    expect((db.prepare("SELECT MAX(version) AS version FROM source_records WHERE source_ref = ?").get(`manual-speaker:${EVENT_A}:${created.record.personId}`) as { version: number }).version).toBe(2);
    expect(count(db, "domain_events")).toBe(2);

    const noOpInput = { personId: created.record.personId, expectedEmail: "BEFORE@EXAMPLE.TEST", expectedFullName: "After Edit", fullName: "After Edit", title: "New title", organization: "New org", bio: "New bio", idempotencyKey: "edit-noop" };
    const noOp = editManualSpeaker(db, scopeA, noOpInput);
    const noOpReplay = editManualSpeaker(db, scopeA, noOpInput);
    expect(noOp).toMatchObject({ record: edited.record, replayed: false, deduped: true });
    expect(noOpReplay).toEqual({ ...noOp, replayed: true, deduped: false });
    expect(() => editManualSpeaker(db, scopeA, { ...noOpInput, title: "Different title" })).toThrow(ManualSpeakerConflictError);
    expect(count(db, "domain_events")).toBe(3);

    closeDb(db);
    databases.splice(databases.indexOf(db), 1);
    const reopened = openDb({ path, seed: false });
    databases.push(reopened);
    expect(listManualSpeakerRecords(reopened, scopeA)).toEqual([edited.record]);
    expect(() => editManualSpeaker(reopened, scopeA, { personId: created.record.personId, expectedEmail: "changed@example.test", expectedFullName: "After Edit", fullName: "Should Not Save", title: "Nope", organization: "Nope", bio: "Nope" })).toThrow(ManualSpeakerConflictError);
    expect((reopened.prepare("SELECT full_name, canonical_email, title, organization FROM people WHERE id = ?").get(created.record.personId) as Record<string, string>)).toEqual({ full_name: "After Edit", canonical_email: "before@example.test", title: "Old title", organization: "Old org" });
  });

  it("replays a no-op edit receipt for an event speaker relation without manual provenance", () => {
    const db = setup();
    const personId = "unprovenanced-person";
    db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(personId, WORKSPACE_A, "unprovenanced@example.test", "Unprovenanced Person", null, null, AT);
    db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'SPEAKER', 'INVITED', ?, ?)").run("unprovenanced-event-link", WORKSPACE_A, EVENT_A, personId, AT, AT);

    const input = {
      personId,
      expectedEmail: "unprovenanced@example.test",
      expectedFullName: "Unprovenanced Person",
      fullName: "Unprovenanced Person",
      idempotencyKey: "unprovenanced-noop-edit",
    };
    const first = editManualSpeaker(db, scopeA, input);
    const receipt = db.prepare("SELECT payload_json FROM domain_events WHERE json_extract(payload_json, '$.idempotencyKey') = ?").get(input.idempotencyKey) as { payload_json: string };

    expect(first).toMatchObject({ replayed: false, deduped: true, record: { personId, managementState: "UNVERIFIED_EVENT_RELATION" } });
    expect(JSON.parse(receipt.payload_json)).toMatchObject({ operation: "noop", sourceRecordId: null, sourceVersion: null });
    expect(editManualSpeaker(db, scopeA, input)).toEqual({ ...first, replayed: true, deduped: false });
    expect(count(db, "source_records")).toBe(0);
    expect(count(db, "domain_events")).toBe(1);
  });

  it("replays an older-event no-op after a cross-event canonical rename without binding stale source evidence", () => {
    const db = setup();
    const older = createManualSpeaker(db, scopeA, {
      fullName: "Original Name",
      email: "cross-event-noop@example.test",
      title: "Older Event Title",
      organization: "Older Event Organization",
      bio: "Older Event Bio",
      idempotencyKey: "cross-event-older-create",
    });
    createManualSpeaker(db, scopeA2, {
      fullName: "Original Name",
      email: "cross-event-noop@example.test",
      title: "Current Event Title",
      organization: "Current Event Organization",
      bio: "Current Event Bio",
      idempotencyKey: "cross-event-current-create",
    });
    editManualSpeaker(db, scopeA2, {
      personId: older.record.personId,
      expectedEmail: older.record.email,
      expectedFullName: "Original Name",
      fullName: "Canonical Renamed",
      title: "Current Event Title",
      organization: "Current Event Organization",
      bio: "Current Event Bio",
      idempotencyKey: "cross-event-canonical-rename",
    });

    const input = {
      personId: older.record.personId,
      expectedEmail: older.record.email,
      expectedFullName: "Canonical Renamed",
      fullName: "Canonical Renamed",
      title: "Older Event Title",
      organization: "Older Event Organization",
      bio: "Older Event Bio",
      idempotencyKey: "cross-event-older-noop-edit",
    };
    const first = editManualSpeaker(db, scopeA, input);
    const receipt = db.prepare("SELECT payload_json FROM domain_events WHERE json_extract(payload_json, '$.idempotencyKey') = ?").get(input.idempotencyKey) as { payload_json: string };

    expect(first).toMatchObject({ replayed: false, deduped: true, record: { fullName: "Canonical Renamed", title: "Older Event Title" } });
    expect(JSON.parse(receipt.payload_json)).toMatchObject({ operation: "noop", sourceRecordId: null, sourceVersion: null });
    expect(editManualSpeaker(db, scopeA, input)).toEqual({ ...first, replayed: true, deduped: false });
    expect(listManualSpeakerRecords(db, scopeA)[0]).toMatchObject({ fullName: "Canonical Renamed", title: "Older Event Title", organization: "Older Event Organization", bio: "Older Event Bio" });
    expect(count(db, "source_records")).toBe(3);
    expect(count(db, "domain_events")).toBe(4);
  });

  it("projects canonical identity globally while keeping manual profile metadata event-scoped", () => {
    const db = setup();
    const first = createManualSpeaker(db, scopeA, {
      fullName: "Shared Person",
      email: "shared@example.test",
      title: "Event A title",
      organization: "Event A organization",
      bio: "Event A bio",
      idempotencyKey: "two-event-a-create",
    });
    createManualSpeaker(db, scopeA2, {
      fullName: "Shared Person",
      email: "shared@example.test",
      title: "Event A2 title",
      organization: "Event A2 organization",
      bio: "Event A2 bio",
      idempotencyKey: "two-event-a2-create",
    });

    editManualSpeaker(db, scopeA, {
      personId: first.record.personId,
      expectedEmail: first.record.email,
      expectedFullName: "Shared Person",
      fullName: "Renamed Person",
      title: "Updated Event A title",
      organization: "Updated Event A organization",
      bio: "Updated Event A bio",
      idempotencyKey: "two-event-a-edit",
    });

    const eventA = listManualSpeakerRecords(db, scopeA)[0]!;
    const eventA2 = listManualSpeakerRecords(db, scopeA2)[0]!;
    expect(eventA).toMatchObject({
      personId: first.record.personId,
      fullName: "Renamed Person",
      email: "shared@example.test",
      title: "Updated Event A title",
      organization: "Updated Event A organization",
      bio: "Updated Event A bio",
      canonicalPerson: { fullName: "Renamed Person", email: "shared@example.test", authority: "workspace-person" },
      eventProfile: { title: "Updated Event A title", organization: "Updated Event A organization", bio: "Updated Event A bio", authority: "event-scoped-manual-source" },
    });
    expect(eventA2).toMatchObject({
      personId: first.record.personId,
      fullName: "Renamed Person",
      email: "shared@example.test",
      title: "Event A2 title",
      organization: "Event A2 organization",
      bio: "Event A2 bio",
      canonicalPerson: { fullName: "Renamed Person", email: "shared@example.test", authority: "workspace-person" },
      eventProfile: { title: "Event A2 title", organization: "Event A2 organization", bio: "Event A2 bio", authority: "event-scoped-manual-source" },
    });

    expect((db.prepare("SELECT full_name, canonical_email, title, organization FROM people WHERE id = ?").get(first.record.personId) as Record<string, string>)).toEqual({ full_name: "Renamed Person", canonical_email: "shared@example.test", title: "Event A title", organization: "Event A organization" });
    const eventA2Source = db.prepare("SELECT payload_json FROM source_records WHERE source_ref = ? ORDER BY version DESC LIMIT 1").get(`manual-speaker:${EVENT_A2}:${first.record.personId}`) as { payload_json: string };
    expect(JSON.parse(eventA2Source.payload_json)).toMatchObject({ eventId: EVENT_A2, personId: first.record.personId, title: "Event A2 title", organization: "Event A2 organization", bio: "Event A2 bio" });
  });

  it("does not copy another event's canonical Person projection into blank event-scoped defaults", () => {
    const db = setup();
    const eventA = createManualSpeaker(db, scopeA, {
      fullName: "Defaults Person",
      email: "defaults@example.test",
      title: "Event A title",
      organization: "Event A organization",
      bio: "Event A bio",
    });
    const eventA2 = createManualSpeaker(db, scopeA2, { fullName: "Defaults Person", email: "defaults@example.test" });

    expect(eventA.record.title).toBe("Event A title");
    expect(eventA2.record).toMatchObject({ title: "", organization: "", bio: "", eventProfile: { authority: "event-scoped-manual-source" } });
    const source = db.prepare("SELECT payload_json FROM source_records WHERE source_ref = ?").get(`manual-speaker:${EVENT_A2}:${eventA.record.personId}`) as { payload_json: string };
    expect(JSON.parse(source.payload_json)).toMatchObject({ eventId: EVENT_A2, title: "", organization: "", bio: "" });
    expect((db.prepare("SELECT full_name, title, organization FROM people WHERE id = ?").get(eventA.record.personId) as Record<string, string | null>)).toMatchObject({ full_name: "Defaults Person", title: "Event A title", organization: "Event A organization" });
  });

  it("rejects a stale cross-event canonical name edit before any partial write", () => {
    const db = setup();
    const eventA = createManualSpeaker(db, scopeA, { fullName: "Concurrent Person", email: "concurrent@example.test", title: "A title" });
    createManualSpeaker(db, scopeA2, { fullName: "Concurrent Person", email: "concurrent@example.test", title: "A2 title" });

    editManualSpeaker(db, scopeA, {
      personId: eventA.record.personId,
      expectedEmail: eventA.record.email,
      expectedFullName: "Concurrent Person",
      fullName: "Event A Rename",
      title: "Updated A title",
      idempotencyKey: "concurrency-event-a",
    });
    const before = {
      sources: count(db, "source_records"),
      events: count(db, "domain_events"),
      eventA2: listManualSpeakerRecords(db, scopeA2)[0]!,
    };

    expect(() => editManualSpeaker(db, scopeA2, {
      personId: eventA.record.personId,
      expectedEmail: eventA.record.email,
      expectedFullName: "Concurrent Person",
      fullName: "Stale Event A2 Rename",
      title: "Should Not Save",
      idempotencyKey: "concurrency-event-a2-stale",
    })).toThrowError(expect.objectContaining({ code: "CANONICAL_NAME_STALE" }));
    expect((db.prepare("SELECT full_name FROM people WHERE id = ?").get(eventA.record.personId) as { full_name: string }).full_name).toBe("Event A Rename");
    expect(count(db, "source_records")).toBe(before.sources);
    expect(count(db, "domain_events")).toBe(before.events);
    expect(listManualSpeakerRecords(db, scopeA2)[0]).toEqual(before.eventA2);
  });

  it("fails closed when a replayed stored envelope loses its fingerprint or aggregate identity", () => {
    const db = setup();
    const fingerprintInput = { fullName: "Corrupt Fingerprint", email: "corrupt-fingerprint@example.test", idempotencyKey: "corrupt-fingerprint" };
    createManualSpeaker(db, scopeA, fingerprintInput);
    const fingerprintEvent = db.prepare("SELECT id FROM domain_events WHERE event_type = 'speaker.manual.created'").get() as { id: string };
    db.exec("DROP TRIGGER IF EXISTS trg_v12_domain_events_immutable");
    db.prepare("UPDATE domain_events SET payload_fingerprint = ? WHERE id = ?").run("0".repeat(64), fingerprintEvent.id);
    const fingerprintCounts = { people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") };
    expect(() => createManualSpeaker(db, scopeA, fingerprintInput)).toThrow(ManualSpeakerError);
    expect({ people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") }).toEqual(fingerprintCounts);

    const aggregateInput = { fullName: "Corrupt Aggregate", email: "corrupt-aggregate@example.test", idempotencyKey: "corrupt-aggregate" };
    createManualSpeaker(db, scopeA, aggregateInput);
    const aggregateEvent = db.prepare("SELECT id FROM domain_events WHERE json_extract(payload_json, '$.idempotencyKey') = ?").get(aggregateInput.idempotencyKey) as { id: string };
    db.prepare("UPDATE domain_events SET aggregate_type = 'forged_aggregate' WHERE id = ?").run(aggregateEvent.id);
    const aggregateCounts = { people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") };
    expect(() => createManualSpeaker(db, scopeA, aggregateInput)).toThrow(ManualSpeakerError);
    expect({ people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") }).toEqual(aggregateCounts);

    const eventTypeInput = { fullName: "Corrupt Event Type", email: "corrupt-event-type@example.test", idempotencyKey: "corrupt-event-type" };
    createManualSpeaker(db, scopeA, eventTypeInput);
    const eventTypeEvent = db.prepare("SELECT id FROM domain_events WHERE json_extract(payload_json, '$.idempotencyKey') = ?").get(eventTypeInput.idempotencyKey) as { id: string };
    db.prepare("UPDATE domain_events SET event_type = 'forged.manual.event' WHERE id = ?").run(eventTypeEvent.id);
    const eventTypeCounts = { people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") };
    expect(() => createManualSpeaker(db, scopeA, eventTypeInput)).toThrow(ManualSpeakerError);
    expect({ people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") }).toEqual(eventTypeCounts);

    const requestInput = { fullName: "Corrupt Request", email: "corrupt-request@example.test", idempotencyKey: "corrupt-request" };
    createManualSpeaker(db, scopeA, requestInput);
    const requestEvent = db.prepare("SELECT id, payload_json FROM domain_events WHERE json_extract(payload_json, '$.idempotencyKey') = ?").get(requestInput.idempotencyKey) as { id: string; payload_json: string };
    const requestPayload = JSON.parse(requestEvent.payload_json) as Record<string, unknown>;
    (requestPayload.request as Record<string, unknown>).fullName = "Forged Request";
    const requestPayloadJson = canonicalJson(requestPayload);
    db.prepare("UPDATE domain_events SET payload_json = ?, payload_fingerprint = ? WHERE id = ?").run(requestPayloadJson, fingerprintOf(requestPayload), requestEvent.id);
    const requestCounts = { people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") };
    expect(() => createManualSpeaker(db, scopeA, requestInput)).toThrow(ManualSpeakerError);
    expect({ people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") }).toEqual(requestCounts);

    const sourceInput = { fullName: "Corrupt Source", email: "corrupt-source@example.test", idempotencyKey: "corrupt-source" };
    createManualSpeaker(db, scopeA, sourceInput);
    const sourceEvent = db.prepare("SELECT id, payload_json FROM domain_events WHERE json_extract(payload_json, '$.idempotencyKey') = ?").get(sourceInput.idempotencyKey) as { id: string; payload_json: string };
    const sourcePayload = JSON.parse(sourceEvent.payload_json) as Record<string, unknown>;
    sourcePayload.sourceRecordId = "missing-source-record";
    const sourcePayloadJson = canonicalJson(sourcePayload);
    db.prepare("UPDATE domain_events SET payload_json = ?, payload_fingerprint = ? WHERE id = ?").run(sourcePayloadJson, fingerprintOf(sourcePayload), sourceEvent.id);
    const sourceCounts = { people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") };
    expect(() => createManualSpeaker(db, scopeA, sourceInput)).toThrow(ManualSpeakerError);
    expect({ people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") }).toEqual(sourceCounts);
  });

  it("derives content-bound edit keys so a no-op reload does not block the next changed edit", () => {
    const db = setup();
    const created = createManualSpeaker(db, scopeA, { fullName: "Reload Person", email: "reload@example.test" });
    const reloaded = listManualSpeakerRecords(db, scopeA)[0]!;
    const noOpInput = { personId: reloaded.personId, expectedEmail: reloaded.email, expectedFullName: reloaded.fullName, fullName: reloaded.fullName, title: reloaded.title, organization: reloaded.organization, bio: reloaded.bio };
    const noOpKey = manualSpeakerEditIdempotencyKey(scopeA, noOpInput);
    expect(editManualSpeaker(db, scopeA, { ...noOpInput, idempotencyKey: noOpKey })).toMatchObject({ deduped: true, replayed: false });

    const changedInput = { ...noOpInput, title: "Second title" };
    const changedKey = manualSpeakerEditIdempotencyKey(scopeA, changedInput);
    expect(changedKey).not.toBe(noOpKey);
    const changed = editManualSpeaker(db, scopeA, { ...changedInput, idempotencyKey: changedKey });
    expect(changed.record.title).toBe("Second title");
    expect(editManualSpeaker(db, scopeA, { ...changedInput, idempotencyKey: changedKey })).toMatchObject({ replayed: true, record: changed.record });
  });

  it("fails closed for cross-tenant or cross-event commands and malformed/control input without partial writes", () => {
    const db = setup();
    const created = createManualSpeaker(db, scopeA, { fullName: "Scoped Person", email: "scoped@example.test" });
    const before = { people: count(db, "people"), links: count(db, "event_speakers"), sources: count(db, "source_records"), events: count(db, "domain_events") };

    expect(() => createManualSpeaker(db, { ...scopeB, eventId: EVENT_A }, { fullName: "Wrong Tenant", email: "wrong@example.test" })).toThrow(ManualSpeakerAuthorizationError);
    expect(() => editManualSpeaker(db, scopeB, { personId: created.record.personId, expectedEmail: created.record.email, expectedFullName: created.record.fullName, fullName: "User B Must Not Edit A" })).toThrow(ManualSpeakerAuthorizationError);
    expect(() => createManualSpeaker(db, { ...scopeA, actorId: "missing-account" }, { fullName: "Unauthenticated", email: "unauthenticated@example.test" })).toThrow(ManualSpeakerAuthorizationError);
    expect(() => editManualSpeaker(db, scopeA2, { personId: created.record.personId, expectedEmail: created.record.email, expectedFullName: created.record.fullName, fullName: "Wrong Event" })).toThrow(ManualSpeakerAuthorizationError);
    expect(() => createManualSpeaker(db, scopeA, { fullName: "Control\u0000Name", email: "control@example.test" })).toThrow(ManualSpeakerInputError);
    expect(() => createManualSpeaker(db, scopeA, { fullName: "Malformed Email", email: "not-an-email" })).toThrow(ManualSpeakerInputError);
    expect(count(db, "people")).toBe(before.people);
    expect(count(db, "event_speakers")).toBe(before.links);
    expect(count(db, "source_records")).toBe(before.sources);
    expect(count(db, "domain_events")).toBe(before.events);

    const otherTenant = createManualSpeaker(db, scopeB, { fullName: "Scoped Person", email: "scoped@example.test" });
    expect(otherTenant.record.personId).not.toBe(created.record.personId);
    expect(count(db, "people")).toBe(before.people + 1);
    expect(listManualSpeakerRecords(db, scopeB).map((record) => record.personId)).toEqual([otherTenant.record.personId]);
  });
});
