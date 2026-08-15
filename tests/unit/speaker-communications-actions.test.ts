import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getEvent: vi.fn(),
  getRouteSession: vi.fn(),
  requireOrganizerWorkspaceRoute: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/services/events", () => ({ getEvent: mocks.getEvent }));
vi.mock("@/server/workspace-session", () => ({
  getRouteSession: mocks.getRouteSession,
  requireOrganizerWorkspaceRoute: mocks.requireOrganizerWorkspaceRoute,
}));

import {
  loadSpeakerCommunicationsSurface,
  queueSpeakerCommunicationsAction,
} from "@/app/w/[workspace]/events/[eventId]/speakers/communications/actions";
import type { SpeakerCommunicationsActionState } from "@/app/w/[workspace]/events/[eventId]/speakers/communications/actions";

const WORKSPACE_ID = "workspace-a";
const EVENT_ID = "event-a";
const PERSON_ID = "person-a";
const FOREIGN_PERSON_ID = "person-b";
const EVENT = { id: EVENT_ID, name: "Evidence Forum" };
const SESSION = {
  id: "session-a",
  tokenHash: "token-hash-a",
  accountId: "account-a",
  workspaceId: WORKSPACE_ID,
  expiresAt: "2099-01-01T00:00:00.000Z",
  email: "organizer@example.test",
  displayName: "Organizer",
  role: "organizer",
  workspaceSlug: "northstar",
  workspaceName: "Northstar",
};
const IDLE_SPEAKER_COMMUNICATIONS_ACTION: SpeakerCommunicationsActionState = { kind: "idle" };

let db: DatabaseSync;

function formFor(personId = PERSON_ID, idempotencyKey = "speaker-batch-1"): FormData {
  const form = new FormData();
  form.set("workspace", "northstar");
  form.set("eventId", EVENT_ID);
  form.set("templateKey", "speaker-bulk-local-v1");
  form.set("idempotencyKey", idempotencyKey);
  form.set("subjectTemplate", "Update for {{eventName}}");
  form.set("bodyTemplate", "Hi {{firstName}},\n\nThis is a local update for {{eventName}}.");
  form.append("personId", personId);
  form.append("email", "attacker@example.test");
  form.append("displayName", "Caller supplied name");
  return form;
}

function seedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE people (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      canonical_email TEXT NOT NULL,
      full_name TEXT NOT NULL,
      organization TEXT,
      title TEXT
    );
    CREATE TABLE event_speakers (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      role_key TEXT NOT NULL
    );
    CREATE TABLE domain_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE outbox_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      domain_event_id TEXT NOT NULL,
      destination_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
  `);
  database.prepare("INSERT INTO events (id, workspace_id, name) VALUES (?, ?, ?)").run(EVENT_ID, WORKSPACE_ID, EVENT.name);
  database.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title) VALUES (?, ?, ?, ?, ?, ?)").run(PERSON_ID, WORKSPACE_ID, "ada@example.test", "Ada Lovelace", "Analytical Engines Lab", "Research Director");
  database.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title) VALUES (?, ?, ?, ?, ?, ?)").run(FOREIGN_PERSON_ID, "workspace-b", "other@example.test", "Other Person", "Other", "Speaker");
  database.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key) VALUES (?, ?, ?, ?, ?)").run("speaker-a", WORKSPACE_ID, EVENT_ID, PERSON_ID, "SPEAKER");
  return database;
}

beforeEach(() => {
  db = seedDatabase();
  mocks.getDb.mockReturnValue(db);
  mocks.getEvent.mockReturnValue(EVENT);
  mocks.getRouteSession.mockResolvedValue(SESSION);
  mocks.requireOrganizerWorkspaceRoute.mockReturnValue(SESSION);
  mocks.revalidatePath.mockReset();
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

describe("speaker communications organizer actions", () => {
  it("derives canonical snapshots, queues PENDING local rows, and exposes history after reload", async () => {
    const first = await queueSpeakerCommunicationsAction(IDLE_SPEAKER_COMMUNICATIONS_ACTION, formFor());

    expect(first).toMatchObject({
      kind: "success",
      code: "SPEAKER_COMMUNICATION_BATCH_QUEUED",
      message: "Queued 1 local message as PENDING. No provider was contacted.",
    });
    expect(mocks.requireOrganizerWorkspaceRoute).toHaveBeenCalledWith(SESSION, "northstar");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/w/northstar/events/${EVENT_ID}/speakers`);

    const outboxRow = db.prepare("SELECT payload_json, status FROM outbox_messages").get() as { payload_json: string; status: string };
    const payload = JSON.parse(outboxRow.payload_json) as { recipient: { normalizedEmail: string; displayName: string; mergeFields: { firstName: string; organization: string; title: string } } };
    expect(outboxRow.status).toBe("PENDING");
    expect(payload.recipient).toMatchObject({
      normalizedEmail: "ada@example.test",
      displayName: "Ada Lovelace",
      mergeFields: { firstName: "Ada", organization: "Analytical Engines Lab", title: "Research Director" },
    });
    expect(payload.recipient.displayName).not.toBe("Caller supplied name");

    const reloaded = await loadSpeakerCommunicationsSurface("northstar", EVENT_ID);
    expect(reloaded?.recipients).toEqual([{
      personId: PERSON_ID,
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      organization: "Analytical Engines Lab",
      title: "Research Director",
      roles: ["SPEAKER"],
    }]);
    expect(reloaded?.history).toHaveLength(1);
    expect(reloaded?.history[0]).toMatchObject({ personId: PERSON_ID, status: "PENDING", channel: "local", providerMutation: false });
  });

  it("rejects a foreign person before writing an outbox row", async () => {
    const result = await queueSpeakerCommunicationsAction(IDLE_SPEAKER_COMMUNICATIONS_ACTION, formFor(FOREIGN_PERSON_ID, "foreign-batch"));

    expect(result).toEqual({
      kind: "error",
      code: "PERSON_NOT_AUTHORIZED",
      message: "One or more selected people are not authorized speakers for this event.",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM domain_events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_messages").get()).toEqual({ count: 0 });
  });
});
