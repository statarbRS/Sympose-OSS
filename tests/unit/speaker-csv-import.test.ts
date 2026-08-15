import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";

import {
  createSyntheticSpeakerOperationsRepository,
  listManualSpeakerRecords,
  SpeakerOperationsAuthorizationError,
} from "@/server/services/speaker-operations";

const event = {
  id: "event-csv-import",
  name: "Synthetic Speaker Forum",
  timezone: "UTC",
  startsAt: "2026-09-15T09:00:00.000Z",
  endsAt: "2026-09-15T17:00:00.000Z",
} as const;

const organizer = {
  kind: "organizer" as const,
  workspaceId: "workspace-csv-import",
  eventId: event.id,
  actorId: "organizer-csv-import",
};

const header = "full_name,email,organization,title,role,program_unit";
const evaluatorHeader = "name,email,title,company,bio";
const durableDatabases: Db[] = [];

afterEach(() => {
  for (const db of durableDatabases.splice(0)) closeDb(db);
});

describe("synthetic speaker CSV import", () => {
  it("creates, merges, and rejects bounded rows without sending email or storing bytes", () => {
    const repository = createSyntheticSpeakerOperationsRepository({ clock: () => "2026-08-12T12:00:10.000Z" });
    const csv = [
      header,
      "New Speaker,new@example.test,New Org,Facilitator,SPEAKER,New session",
      ",missing@example.test,New Org,Facilitator,SPEAKER,Missing name",
      "Bad Role,bad@example.test,New Org,Facilitator,HOST,Bad session",
    ].join("\n");

    const first = repository.importSpeakerCsv(organizer, event, csv, "csv-import-v1");

    expect(first).toMatchObject({ rowCount: 3, createdCount: 1, mergedCount: 0, rejectedCount: 2, emailSent: false, fileBytesStored: false });
    expect(first.rows.map((row) => row.status)).toEqual(["CREATED", "REJECTED", "REJECTED"]);
    expect(Object.isFrozen(first)).toBe(true);
    const createdPersonId = first.rows[0]!.personId;
    expect(createdPersonId).toEqual(expect.any(String));

    const projectionAfterCreate = repository.getOrganizerProjection(organizer, event);
    const created = projectionAfterCreate.roster.find((record) => record.person.personId === createdPersonId);
    expect(created).toMatchObject({
      person: { fullName: "New Speaker", organization: "New Org", title: "Facilitator", canonicalIdentity: "Person" },
      invitation: { state: "DRAFT", deliveryEvidence: { deliveryState: "NOT_SENT" } },
      communications: [],
    });
    expect(projectionAfterCreate.roster).toHaveLength(4);

    const second = repository.importSpeakerCsv(organizer, event, `${header}\nNew Speaker,new@example.test,New Org,Changed title,SPEAKER,Changed session`);
    expect(second).toMatchObject({ rowCount: 1, createdCount: 0, mergedCount: 1, rejectedCount: 0 });
    expect(second.rows[0]).toMatchObject({ status: "MERGED", personId: createdPersonId });
    expect(repository.getOrganizerProjection(organizer, event).roster).toHaveLength(4);
    expect(repository.getOrganizerProjection(organizer, event).roster.find((record) => record.person.personId === createdPersonId)?.person.title).toBe("Facilitator");

    const replay = repository.importSpeakerCsv(organizer, event, csv, "csv-import-v1");
    expect(replay).toEqual(first);
  });

  it("keeps the canonical Person identity workspace-stable while enforcing event authorization", () => {
    const repository = createSyntheticSpeakerOperationsRepository({ clock: () => "2026-08-12T12:00:10.000Z" });
    const csv = `${header}\nCross Event,cross@example.test,Cross Org,Speaker,SPEAKER,Cross session`;
    const first = repository.importSpeakerCsv(organizer, event, csv);
    const otherEvent = { ...event, id: "event-csv-import-2" };
    const second = repository.importSpeakerCsv({ ...organizer, eventId: otherEvent.id }, otherEvent, csv);
    const otherWorkspace = { ...organizer, workspaceId: "workspace-csv-import-other", eventId: event.id };
    const third = repository.importSpeakerCsv(otherWorkspace, event, csv);

    expect(second.rows[0]?.personId).toBe(first.rows[0]?.personId);
    expect(third.rows[0]?.personId).not.toBe(first.rows[0]?.personId);
    expect(repository.getOrganizerProjection(organizer, event).roster.some((record) => record.person.personId === first.rows[0]?.personId)).toBe(true);
    expect(() => repository.importSpeakerCsv({ ...organizer, eventId: "foreign-event" }, event, csv)).toThrow(SpeakerOperationsAuthorizationError);
  });

  it("accepts the evaluator fixture schema, retains bios, replays idempotently, and merges by normalized email", () => {
    const repository = createSyntheticSpeakerOperationsRepository({ clock: () => "2026-08-12T12:00:10.000Z" });
    const priyaBio = "Priya builds reliable systems, teams, and communities.";
    const marcusBio = "Marcus helps mission-driven organizations turn ideas into action.";
    const danaBio = "Dana creates durable partnerships for public-interest programs.";
    const csv = [
      evaluatorHeader,
      `Priya Raman,priya.raman@example.test,VP Engineering,Northstar Labs,"${priyaBio}"`,
      `Marcus Okafor,marcus.okafor@example.test,Founder,Open Commons,"${marcusBio}"`,
      `Dana Kowalski,,Program Director,Kowalski Studio,"${danaBio}"`,
    ].join("\n");

    const first = repository.importSpeakerCsv(organizer, event, csv, "evaluator-speakers-v1");

    expect(first).toMatchObject({
      columns: ["name", "email", "title", "company", "bio"],
      rowCount: 3,
      createdCount: 3,
      mergedCount: 0,
      rejectedCount: 0,
      emailSent: false,
      fileBytesStored: false,
    });
    expect(first.rows.map((row) => row.status)).toEqual(["CREATED", "CREATED", "CREATED"]);

    const imported = repository.getOrganizerProjection(organizer, event).roster.filter((record) => ["Priya Raman", "Marcus Okafor", "Dana Kowalski"].includes(record.person.fullName));
    expect(imported).toHaveLength(3);
    expect(imported).toEqual(expect.arrayContaining([
      expect.objectContaining({
        person: expect.objectContaining({ fullName: "Priya Raman", organization: "Northstar Labs", title: "VP Engineering", canonicalIdentity: "Person" }),
        role: "SPEAKER",
        assignment: expect.objectContaining({ role: "SPEAKER", programUnitName: "Imported speaker program unit" }),
        profile: expect.objectContaining({ workspaceProfile: expect.objectContaining({ bio: priyaBio }) }),
        invitation: expect.objectContaining({ deliveryEvidence: expect.objectContaining({ deliveryState: "NOT_SENT" }) }),
        communications: [],
      }),
      expect.objectContaining({
        person: expect.objectContaining({ fullName: "Marcus Okafor", organization: "Open Commons", title: "Founder", canonicalIdentity: "Person" }),
        profile: expect.objectContaining({ workspaceProfile: expect.objectContaining({ bio: marcusBio }) }),
      }),
      expect.objectContaining({
        person: expect.objectContaining({ fullName: "Dana Kowalski", organization: "Kowalski Studio", title: "Program Director", canonicalIdentity: "Person" }),
        profile: expect.objectContaining({ workspaceProfile: expect.objectContaining({ bio: danaBio }) }),
      }),
    ]));

    const merged = repository.importSpeakerCsv(organizer, event, [
      evaluatorHeader,
      "Priya Re-imported,PRIYA.RAMAN@EXAMPLE.TEST,Changed title,Changed company,Changed bio",
    ].join("\n"));

    expect(merged).toMatchObject({ rowCount: 1, createdCount: 0, mergedCount: 1, rejectedCount: 0 });
    expect(merged.rows[0]).toMatchObject({ status: "MERGED", personId: first.rows[0]?.personId });
    const unchangedPriya = repository.getOrganizerProjection(organizer, event).roster.find((record) => record.person.fullName === "Priya Raman");
    expect(unchangedPriya).toMatchObject({
      person: { fullName: "Priya Raman", organization: "Northstar Labs", title: "VP Engineering" },
      profile: { workspaceProfile: expect.objectContaining({ bio: priyaBio }) },
    });

    const replay = repository.importSpeakerCsv(organizer, event, csv, "evaluator-speakers-v1");
    expect(replay).toEqual(first);
    expect(repository.getOrganizerProjection(organizer, event).roster.filter((record) => ["Priya Raman", "Marcus Okafor", "Dana Kowalski"].includes(record.person.fullName))).toHaveLength(3);
  });

  it("rehydrates CSV receipts through canonical Person provenance without inventing plan authority", () => {
    const db = openDb({ path: ":memory:", seed: false });
    durableDatabases.push(db);
    const workspaceId = "durable-csv-workspace";
    const eventId = "durable-csv-event";
    const actorId = "durable-csv-organizer";
    const at = "2026-08-12T12:00:00.000Z";
    db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(workspaceId, "durable-csv", "Durable CSV", at);
    db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, 'organizer', ?)").run(actorId, workspaceId, "organizer@durable-csv.test", "Durable CSV Organizer", at);
    db.prepare("INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, 'UTC', ?, ?, ?)").run(eventId, workspaceId, "Durable CSV Event", "2026-09-15T09:00:00.000Z", "2026-09-15T17:00:00.000Z", at);
    const durableScope = { kind: "organizer" as const, workspaceId, eventId, actorId };
    const durableEvent = { id: eventId, name: "Durable CSV Event", timezone: "UTC", startsAt: "2026-09-15T09:00:00.000Z", endsAt: "2026-09-15T17:00:00.000Z" } as const;
    const csv = `${header}\nDurable Speaker,durable@example.test,Durable Org,Researcher,SPEAKER,Imported session`;
    const first = createSyntheticSpeakerOperationsRepository({ db, clock: () => at });
    expect(first.getOrganizerProjection(durableScope, durableEvent).roster).toEqual([]);
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM people WHERE workspace_id = ?) AS people,
         (SELECT COUNT(*) FROM speaker_tasks WHERE workspace_id = ?) AS tasks,
         (SELECT COUNT(*) FROM speaker_content_versions WHERE workspace_id = ?) AS content,
         (SELECT COUNT(*) FROM domain_events WHERE workspace_id = ?) AS events,
         (SELECT COUNT(*) FROM outbox_messages WHERE workspace_id = ?) AS outbox`,
    ).get(workspaceId, workspaceId, workspaceId, workspaceId, workspaceId)).toEqual({ people: 0, tasks: 0, content: 0, events: 0, outbox: 0 });
    const receipt = first.importSpeakerCsv(durableScope, durableEvent, csv, "durable-csv-v1");
    expect(receipt).toMatchObject({ createdCount: 1, mergedCount: 0, rejectedCount: 0 });
    const personId = receipt.rows[0]?.personId;
    expect(personId).toEqual(expect.any(String));
    expect(db.prepare("SELECT workspace_id, canonical_email, full_name FROM people WHERE id = ?").get(personId)).toEqual({ workspace_id: workspaceId, canonical_email: "durable@example.test", full_name: "Durable Speaker" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_records WHERE workspace_id = ?").get(workspaceId)).toEqual({ count: 1 });

    db.prepare("UPDATE people SET full_name = ?, organization = ?, title = ? WHERE id = ? AND workspace_id = ?")
      .run("Canonical Renamed", "Canonical Org", "Canonical Title", personId, workspaceId);

    const rebuilt = createSyntheticSpeakerOperationsRepository({ db, clock: () => at });
    const projected = rebuilt.getOrganizerProjection(durableScope, durableEvent).roster.find((record) => record.person.personId === personId);
    expect(projected).toBeUndefined();
    expect(listManualSpeakerRecords(db, durableScope)).toEqual([
      expect.objectContaining({ personId, fullName: "Canonical Renamed", organization: "Durable Org", title: "Researcher" }),
    ]);
    expect(rebuilt.importSpeakerCsv(durableScope, durableEvent, csv, "durable-csv-v1")).toEqual(receipt);

    const noEmail = rebuilt.importSpeakerCsv(durableScope, durableEvent, `${header}\nNo Email,,No Org,Researcher,SPEAKER,No identity`);
    expect(noEmail).toMatchObject({ createdCount: 0, mergedCount: 0, rejectedCount: 1 });
    expect(noEmail.rows[0]?.detail).toContain("requires an email address");
    expect(db.prepare("SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?").get(workspaceId)).toEqual({ count: 1 });
  });
});
