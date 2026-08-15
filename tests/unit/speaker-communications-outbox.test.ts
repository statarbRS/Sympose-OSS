import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb } from "../../src/server/db";
import {
  SPEAKER_COMMUNICATION_TEMPLATE_KEY,
  SpeakerCommunicationsAuthorizationError,
  SpeakerCommunicationsConflictError,
  SpeakerCommunicationsInputError,
  listSpeakerCommunicationDeliveryLog,
  queueSpeakerCommunicationBatch,
} from "../../src/server/services/speaker-communications";

const WORKSPACE_A = "communications-workspace-a";
const WORKSPACE_B = "communications-workspace-b";
const EVENT_A = "communications-event-a";
const EVENT_B = "communications-event-b";
const PERSON_A1 = "communications-person-a1";
const PERSON_A2 = "communications-person-a2";
const PERSON_A3 = "communications-person-a3";
const PERSON_B1 = "communications-person-b1";

const databases: DatabaseSync[] = [];
const temporaryDirectories: string[] = [];

function seedDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "sympose-speaker-communications-"));
  temporaryDirectories.push(directory);
  const db = openDb({ path: join(directory, "sympose.db"), seed: false });
  databases.push(db);
  const at = "2026-08-12T12:00:00.000Z";
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(WORKSPACE_A, "communications-a", "Communications A", at);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(WORKSPACE_B, "communications-b", "Communications B", at);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(EVENT_A, WORKSPACE_A, "Stage 2 Speaker Forum", "UTC", "2026-09-01T09:00:00.000Z", "2026-09-01T17:00:00.000Z", at);
  db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(EVENT_B, WORKSPACE_B, "Other Workspace Forum", "UTC", "2026-09-02T09:00:00.000Z", "2026-09-02T17:00:00.000Z", at);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(PERSON_A1, WORKSPACE_A, "ada@example.test", "Ada Lovelace", "Analytical Engines", "Speaker", at);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(PERSON_A2, WORKSPACE_A, "grace@example.test", "Grace Hopper", "Compilers", "Speaker", at);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(PERSON_A3, WORKSPACE_A, "unbound@example.test", "Unbound Speaker", "Unbound", "Speaker", at);
  db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(PERSON_B1, WORKSPACE_B, "other@example.test", "Other Speaker", "Other", "Speaker", at);
  db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("communications-speaker-a1", WORKSPACE_A, EVENT_A, PERSON_A1, "SPEAKER", "INVITED", at, at);
  db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("communications-speaker-a2", WORKSPACE_A, EVENT_A, PERSON_A2, "SPEAKER", "INVITED", at, at);
  db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("communications-speaker-b1", WORKSPACE_B, EVENT_B, PERSON_B1, "SPEAKER", "INVITED", at, at);
  return db;
}

function baseInput() {
  return {
    workspaceId: WORKSPACE_A,
    eventId: EVENT_A,
    idempotencyKey: "communications-batch-1",
    templateKey: SPEAKER_COMMUNICATION_TEMPLATE_KEY,
    subjectTemplate: "Hello {{displayName}} — {{eventName}}",
    bodyTemplate: "Hi {{firstName}},\n\nThe {{eventName}} team will follow up with your {{title}} session.",
    recipients: [
      {
        personId: PERSON_A1,
        email: "ADA@EXAMPLE.TEST",
        displayName: "Ada Lovelace",
        mergeFields: { firstName: "Ada", title: "keynote" },
      },
      {
        personId: PERSON_A2,
        email: "grace@example.test",
        displayName: "Grace Hopper",
        mergeFields: { firstName: "Grace", title: "workshop" },
      },
    ],
  } as const;
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable speaker communications outbox", () => {
  it("queues two local recipients, renders merges, projects the log, and replays exactly", () => {
    const db = seedDatabase();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider must not be called"));
    try {
      const receipt = queueSpeakerCommunicationBatch(db, baseInput());
      expect(receipt).toMatchObject({
        workspaceId: WORKSPACE_A,
        eventId: EVENT_A,
        templateKey: SPEAKER_COMMUNICATION_TEMPLATE_KEY,
        recipientCount: 2,
        channel: "local",
        providerMutation: false,
      });
      expect(receipt.messages.map((message) => message.normalizedEmail)).toEqual(["ada@example.test", "grace@example.test"]);
      expect(receipt.messages[0]).toMatchObject({
        personId: PERSON_A1,
        subjectPreview: "Hello Ada Lovelace — Stage 2 Speaker Forum",
        bodyPreview: "Hi Ada,\n\nThe Stage 2 Speaker Forum team will follow up with your keynote session.",
        status: "PENDING",
      });
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();

      const eventRows = db.prepare("SELECT id, workspace_id, event_type, payload_json, payload_fingerprint FROM domain_events").all() as Array<{ id: string; workspace_id: string; event_type: string; payload_json: string; payload_fingerprint: string }>;
      const outboxRows = db.prepare("SELECT id, workspace_id, domain_event_id, destination_key, payload_json, status FROM outbox_messages ORDER BY created_at, rowid").all() as Array<{ id: string; workspace_id: string; domain_event_id: string; destination_key: string; payload_json: string; status: string }>;
      expect(eventRows).toHaveLength(1);
      expect(outboxRows).toHaveLength(2);
      expect(eventRows[0]).toMatchObject({ workspace_id: WORKSPACE_A, event_type: "speaker.communication.batch.queued" });
      expect(outboxRows.every((row) => row.workspace_id === WORKSPACE_A && row.domain_event_id === receipt.domainEventId && row.status === "PENDING")).toBe(true);
      for (const row of outboxRows) {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        const { payloadFingerprint, ...payloadBasis } = payload;
        expect(row.payload_json).toBe(canonicalJson(payload));
        expect(payloadFingerprint).toBe(fingerprintOf(payloadBasis));
        expect(payload.providerMutation).toBe(false);
        expect(payload.channel).toBe("local");
        expect(row.destination_key).toBe(payload.destinationKey);
      }
      expect(eventRows[0]!.payload_json).toBe(canonicalJson(JSON.parse(eventRows[0]!.payload_json)));
      expect(eventRows[0]!.payload_fingerprint).toBe(fingerprintOf(JSON.parse(eventRows[0]!.payload_json)));

      const log = listSpeakerCommunicationDeliveryLog(db, { workspaceId: WORKSPACE_A, eventId: EVENT_A });
      expect(log).toHaveLength(2);
      expect(log.map((row) => row.personId)).toEqual([PERSON_A1, PERSON_A2]);
      expect(log.every((row) => row.status === "PENDING" && row.channel === "local" && row.providerMutation === false)).toBe(true);
      expect(log[0]).toMatchObject({ normalizedEmail: "ada@example.test", subjectPreview: receipt.messages[0]!.subjectPreview });

      const replay = queueSpeakerCommunicationBatch(db, baseInput());
      expect(replay).toEqual(receipt);
      expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual({ count: 2 });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("denies cross-tenant, cross-event, and unbound-person recipients before writing", () => {
    const db = seedDatabase();
    const input = baseInput();
    expect(() => queueSpeakerCommunicationBatch(db, {
      ...input,
      recipients: [{ ...input.recipients[0], personId: PERSON_B1, email: "other@example.test", displayName: "Other Speaker" }],
    })).toThrow(SpeakerCommunicationsAuthorizationError);
    expect(() => queueSpeakerCommunicationBatch(db, {
      ...input,
      recipients: [{ ...input.recipients[0], personId: PERSON_A3, email: "unbound@example.test", displayName: "Unbound Speaker" }],
    })).toThrow(SpeakerCommunicationsAuthorizationError);
    expect(() => queueSpeakerCommunicationBatch(db, {
      ...input,
      eventId: EVENT_B,
      recipients: [{ ...input.recipients[0], personId: PERSON_B1, email: "other@example.test", displayName: "Other Speaker" }],
    })).toThrow(SpeakerCommunicationsAuthorizationError);
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual({ count: 0 });
  });

  it("rejects duplicate email destinations and conflicting idempotency reuse", () => {
    const db = seedDatabase();
    const input = baseInput();
    expect(() => queueSpeakerCommunicationBatch(db, {
      ...input,
      idempotencyKey: "duplicate-email",
      recipients: [
        input.recipients[0],
        { ...input.recipients[1], email: input.recipients[0].email },
      ],
    })).toThrow(SpeakerCommunicationsInputError);

    queueSpeakerCommunicationBatch(db, input);
    expect(() => queueSpeakerCommunicationBatch(db, {
      ...input,
      subjectTemplate: "Changed {{displayName}}",
    })).toThrow(SpeakerCommunicationsConflictError);
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual({ count: 2 });
  });

  it("rejects unknown placeholders and header/control-character injection", () => {
    const db = seedDatabase();
    const input = baseInput();
    expect(() => queueSpeakerCommunicationBatch(db, {
      ...input,
      idempotencyKey: "unknown-placeholder",
      subjectTemplate: "Hello {{secretToken}}",
    })).toThrow(SpeakerCommunicationsInputError);
    expect(() => queueSpeakerCommunicationBatch(db, {
      ...input,
      idempotencyKey: "header-injection",
      subjectTemplate: "Hello\r\nBcc: attacker@example.test",
    })).toThrow(SpeakerCommunicationsInputError);
    expect(() => queueSpeakerCommunicationBatch(db, {
      ...input,
      idempotencyKey: "html-body",
      bodyTemplate: "<b>Hello {{displayName}}</b>",
    })).toThrow(SpeakerCommunicationsInputError);
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual({ count: 0 });
  });
});
