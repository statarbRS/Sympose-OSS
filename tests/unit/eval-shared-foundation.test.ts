import { describe, expect, it } from "vitest";

import { closeDb, openDb } from "../../src/server/db";

describe("evaluator shared foundation schema", () => {
  it("installs the additive speaker, outbox, and allocation contracts", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "21" });
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('event_speakers','domain_events','outbox_messages','event_tracks','event_rooms','event_session_allocations') ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual([
        "domain_events",
        "event_rooms",
        "event_session_allocations",
        "event_speakers",
        "event_tracks",
        "outbox_messages",
      ]);
    } finally {
      closeDb(db);
    }
  });

  it("keeps participation, evidence, and allocation records tenant-bound", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      const workspaceA = "workspace-a";
      const workspaceB = "workspace-b";
      const eventA = "event-a";
      const eventB = "event-b";
      const personA = "person-a";
      const personB = "person-b";
      const programA = "program-a";
      const programA2 = "program-a-2";
      const programB = "program-b";
      const roomA = "room-a";
      const roomB = "room-b";
      const trackA = "track-a";
      const trackB = "track-b";

      db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(workspaceA, "a", "A", "2026-01-01");
      db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(workspaceB, "b", "B", "2026-01-01");
      db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(eventA, workspaceA, "A", "UTC", "2026-01-01", "2026-01-02", "2026-01-01");
      db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(eventB, workspaceB, "B", "UTC", "2026-01-01", "2026-01-02", "2026-01-01");
      db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)").run(personA, workspaceA, "a@example.test", "A", "2026-01-01");
      db.prepare("INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at) VALUES (?, ?, ?, ?, ?)").run(personB, workspaceB, "b@example.test", "B", "2026-01-01");
      db.prepare("INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(programA, workspaceA, eventA, "Session", "session", "2026-01-01", "2026-01-02", 10, "2026-01-01");
      db.prepare("INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(programA2, workspaceA, eventA, "Session 2", "session", "2026-01-01", "2026-01-02", 10, "2026-01-01");
      db.prepare("INSERT INTO program_units (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(programB, workspaceB, eventB, "Session", "session", "2026-01-01", "2026-01-02", 10, "2026-01-01");
      db.prepare("INSERT INTO event_rooms (id, workspace_id, event_id, name, created_at) VALUES (?, ?, ?, ?, ?)").run(roomA, workspaceA, eventA, "Main", "2026-01-01");
      db.prepare("INSERT INTO event_rooms (id, workspace_id, event_id, name, created_at) VALUES (?, ?, ?, ?, ?)").run(roomB, workspaceB, eventB, "Main", "2026-01-01");
      db.prepare("INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(trackA, workspaceA, eventA, "Platform", "platform", "2026-01-01");
      db.prepare("INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(trackB, workspaceB, eventB, "Platform", "platform", "2026-01-01");

      db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("speaker-a", workspaceA, eventA, personA, "2026-01-01", "2026-01-01");
      expect(() => db.prepare("INSERT INTO event_speakers (id, workspace_id, event_id, person_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("speaker-cross-tenant", workspaceB, eventA, personA, "2026-01-01", "2026-01-01")).toThrow();
      expect(() => db.prepare("UPDATE event_speakers SET workspace_id=?, event_id=?, person_id=? WHERE id=?").run(workspaceB, eventB, personB, "speaker-a")).toThrow();

      expect(() => db.prepare("UPDATE event_tracks SET workspace_id=?, event_id=? WHERE id=?").run(workspaceB, eventB, trackA)).toThrow();
      expect(() => db.prepare("UPDATE event_rooms SET workspace_id=?, event_id=? WHERE id=?").run(workspaceB, eventB, roomA)).toThrow();

      const payload = JSON.stringify({ eventId: eventA, kind: "session.created" });
      const fingerprint = db.prepare("SELECT sympose_pd01_fingerprint(?) AS fingerprint").get(payload) as { fingerprint: string };
      db.prepare("INSERT INTO domain_events (id, workspace_id, event_type, aggregate_type, aggregate_id, payload_json, payload_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("domain-a", workspaceA, "session.created", "program_unit", programA, payload, fingerprint.fingerprint, "2026-01-01");
      const payloadB = JSON.stringify({ eventId: eventB, kind: "session.created" });
      const fingerprintB = db.prepare("SELECT sympose_pd01_fingerprint(?) AS fingerprint").get(payloadB) as { fingerprint: string };
      db.prepare("INSERT INTO domain_events (id, workspace_id, event_type, aggregate_type, aggregate_id, payload_json, payload_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("domain-b", workspaceB, "session.created", "program_unit", programB, payloadB, fingerprintB.fingerprint, "2026-01-01");
      db.prepare("INSERT INTO outbox_messages (id, workspace_id, domain_event_id, destination_key, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("outbox-a", workspaceA, "domain-a", "local-evaluator", payload, "2026-01-01");
      expect(() => db.prepare("INSERT INTO outbox_messages (id, workspace_id, domain_event_id, destination_key, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("outbox-cross-tenant", workspaceB, "domain-a", "local-evaluator", payload, "2026-01-01")).toThrow();
      expect(() => db.prepare("UPDATE outbox_messages SET workspace_id=?, domain_event_id=?, payload_json=? WHERE id=?").run(workspaceB, "domain-b", payloadB, "outbox-a")).toThrow();
      expect(() => db.prepare("UPDATE domain_events SET aggregate_id='changed' WHERE id='domain-a'").run()).toThrow();

      db.prepare("INSERT INTO event_session_allocations (id, workspace_id, event_id, program_unit_id, room_id, track_id, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("allocation-a", workspaceA, eventA, programA, roomA, trackA, "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", "2026-01-01", "2026-01-01");
      expect(() => db.prepare("INSERT INTO event_session_allocations (id, workspace_id, event_id, program_unit_id, room_id, track_id, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("allocation-overlap", workspaceA, eventA, programA, roomA, trackA, "2026-01-01T10:30:00Z", "2026-01-01T11:30:00Z", "2026-01-01", "2026-01-01")).toThrow();
      expect(() => db.prepare("INSERT INTO event_session_allocations (id, workspace_id, event_id, program_unit_id, room_id, track_id, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("allocation-cross-tenant", workspaceB, eventB, programA, roomA, trackA, "2026-01-01T12:00:00Z", "2026-01-01T13:00:00Z", "2026-01-01", "2026-01-01")).toThrow();
      db.prepare("INSERT INTO event_session_allocations (id, workspace_id, event_id, program_unit_id, room_id, track_id, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("allocation-a-2", workspaceA, eventA, programA2, roomA, trackA, "2026-01-01T12:00:00Z", "2026-01-01T13:00:00Z", "2026-01-01", "2026-01-01");
      expect(() => db.prepare("UPDATE event_session_allocations SET workspace_id=?, event_id=?, program_unit_id=?, room_id=?, track_id=? WHERE id=?").run(workspaceB, eventB, programB, roomB, trackB, "allocation-a")).toThrow();
      expect(() => db.prepare("UPDATE event_session_allocations SET updated_at=? WHERE id=?").run("2026-01-01T00:00:01Z", "allocation-a")).not.toThrow();
      expect(() => db.prepare("UPDATE event_session_allocations SET starts_at=?, ends_at=?, updated_at=? WHERE id=?").run("2026-01-01T10:30:00Z", "2026-01-01T11:30:00Z", "2026-01-01T00:00:02Z", "allocation-a-2")).toThrow();
    } finally {
      closeDb(db);
    }
  });
});
