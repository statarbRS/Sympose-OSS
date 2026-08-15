import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deterministicUuid } from "@/server/canonical";
import { closeDb, openDb, type Db } from "@/server/db";
import { seedWorkspaces } from "@/server/seed";
import { getWorkspaceBySlug } from "@/server/services/queries";
import { freezeCohortSnapshot } from "@/server/services/cohorts";
import {
  commitmentResponseCommandKey,
  deliverOffers,
  nextPendingOffer,
  respondToOfferCommand,
} from "@/server/services/commitments";
import { createEventWithUnit } from "@/server/services/events";
import { approvePlan, compilePlan } from "@/server/services/planning";
import { importFixtureEvidence } from "@/server/services/sources";
import { sealRelease, validatePublicReleaseForRead } from "@/server/services/publication";
import { resolveCurrentDurablePublicAgenda } from "@/server/services/public-agenda";
import { publicReleaseReference } from "@/server/services/public-reference";
import { createSyntheticSpeakerOperationsRepository } from "@/server/services/speaker-operations";
import { persistAndApproveCurrentSchedule } from "../helpers/schedule-approval";

const temporaryDirectories: string[] = [];

function seedSealedRelease(db: Db) {
  const workspace = getWorkspaceBySlug(db, "northstar");
  if (!workspace) throw new Error("missing seeded workspace");
  const account = db
    .prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY created_at LIMIT 1")
    .get(workspace.id) as { id: string } | undefined;
  if (!account) throw new Error("missing seeded organizer");
  const actor = { kind: "account" as const, ref: account.id };

  importFixtureEvidence(db, workspace.id, workspace.slug);
  freezeCohortSnapshot(db, workspace.id, actor);
  const event = createEventWithUnit(db, workspace.id, actor, {
    eventName: "Durable publication test event",
    unitName: "Published unit",
  });
  const plan = compilePlan(db, workspace.id, event.eventId, actor);
  approvePlan(db, workspace.id, event.eventId, plan.planVersionId, null, actor);
  deliverOffers(db, workspace.id, event.eventId, actor);
  const offer = nextPendingOffer(db, workspace.id, event.eventId);
  if (!offer) throw new Error("missing pending commitment offer");
  const offerTerms = JSON.parse(offer.termsJson) as { readonly role?: unknown };
  const roleKey = offerTerms.role === "MODERATOR" || offerTerms.role === "moderator"
    ? "MODERATOR"
    : offerTerms.role === "SPEAKER" || offerTerms.role === "participant"
      ? "SPEAKER"
      : null;
  if (!roleKey) throw new Error("pending commitment offer has an unsupported speaker role");
  respondToOfferCommand(db, workspace.id, event.eventId, {
    offerId: offer.id,
    response: "accepted",
    commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
  });

  const seededAt = "2026-08-13T00:00:00.000Z";
  const roomId = deterministicUuid(`public-agenda-test:room:${event.eventId}`);
  const trackId = deterministicUuid(`public-agenda-test:track:${event.eventId}`);
  const allocationId = deterministicUuid(`public-agenda-test:allocation:${event.eventId}`);
  const unit = db.prepare(
    `SELECT starts_at AS startsAt, ends_at AS endsAt
       FROM program_units WHERE workspace_id = ? AND event_id = ? AND id = ?`,
  ).get(workspace.id, event.eventId, event.programUnitId) as { startsAt: string; endsAt: string };
  db.prepare(
    `INSERT INTO event_rooms (id, workspace_id, event_id, name, capacity, created_at)
     VALUES (?, ?, ?, 'Durable test room', 20, ?)`,
  ).run(roomId, workspace.id, event.eventId, seededAt);
  db.prepare(
    `INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at)
     VALUES (?, ?, ?, 'Durable test track', 'durable-test-track', ?)`,
  ).run(trackId, workspace.id, event.eventId, seededAt);
  db.prepare(
    `INSERT INTO event_session_allocations
       (id, workspace_id, event_id, program_unit_id, room_id, track_id,
        starts_at, ends_at, allocation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
  ).run(
    allocationId,
    workspace.id,
    event.eventId,
    event.programUnitId,
    roomId,
    trackId,
    unit.startsAt,
    unit.endsAt,
    seededAt,
    seededAt,
  );
  db.prepare(
    `INSERT INTO event_speakers
       (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?)`,
  ).run(
    deterministicUuid(`public-agenda-test:speaker:${event.eventId}`),
    workspace.id,
    event.eventId,
    offer.personId,
    roleKey,
    seededAt,
    seededAt,
  );
  const speaker = createSyntheticSpeakerOperationsRepository({ db, clock: () => seededAt });
  const speakerScope = {
    kind: "organizer" as const,
    workspaceId: workspace.id,
    eventId: event.eventId,
    actorId: account.id,
  };
  const titleTask = speaker.createTask(speakerScope, {
    personId: offer.personId,
    kind: "SESSION_TITLE",
    contentKind: "SESSION_TITLE",
    title: "Durable session title",
    description: "The approved title for the durable agenda test.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2026-09-01T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: `public-agenda-test:title-task:${event.eventId}`,
  });
  const abstractTask = speaker.createTask(speakerScope, {
    personId: offer.personId,
    kind: "SESSION_DESCRIPTION",
    contentKind: "SESSION_DESCRIPTION",
    title: "Durable session abstract",
    description: "The approved abstract for the durable agenda test.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2026-09-01T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: `public-agenda-test:abstract-task:${event.eventId}`,
  });
  const title = speaker.submitOrganizerContent(speakerScope, {
    personId: offer.personId,
    taskId: titleTask.id,
    payload: { kind: "SESSION_TITLE", title: "Durable published title" },
    idempotencyKey: `public-agenda-test:title-version:${event.eventId}`,
  });
  const abstract = speaker.submitOrganizerContent(speakerScope, {
    personId: offer.personId,
    taskId: abstractTask.id,
    payload: { kind: "SESSION_DESCRIPTION", description: "Durable published abstract" },
    idempotencyKey: `public-agenda-test:abstract-version:${event.eventId}`,
  });
  speaker.approveContent(speakerScope, {
    personId: offer.personId,
    taskId: titleTask.id,
    submissionVersionId: title.id,
    submissionContentHash: title.contentHash,
    gate: "PUBLICATION",
    idempotencyKey: `public-agenda-test:title-approval:${event.eventId}`,
  });
  speaker.approveContent(speakerScope, {
    personId: offer.personId,
    taskId: abstractTask.id,
    submissionVersionId: abstract.id,
    submissionContentHash: abstract.contentHash,
    gate: "PUBLICATION",
    idempotencyKey: `public-agenda-test:abstract-approval:${event.eventId}`,
  });
  persistAndApproveCurrentSchedule(
    db,
    { workspaceId: workspace.id, eventId: event.eventId },
    account.id,
    `public-agenda-${event.eventId}`,
  );

  return {
    workspaceId: workspace.id,
    eventId: event.eventId,
    programUnitId: event.programUnitId,
    personId: offer.personId,
    release: sealRelease(db, workspace.id, event.eventId, actor),
  };
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(process.cwd(), ".public-agenda-"));
  temporaryDirectories.push(directory);
  return join(directory, "sympose.db");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable public agenda authority", () => {
  it("reconstructs the current sealed projection after the database connection is reopened", () => {
    const path = temporaryDatabasePath();
    const firstDb = openDb({ path, seed: false });
    seedWorkspaces(firstDb);
    const seeded = seedSealedRelease(firstDb);
    closeDb(firstDb);

    const reloadedDb = openDb({ path, seed: false });
    try {
      const releaseReference = publicReleaseReference({
        workspaceId: seeded.workspaceId,
        eventId: seeded.eventId,
        releaseId: seeded.release.releaseId,
      });
      const projection = resolveCurrentDurablePublicAgenda(reloadedDb, releaseReference);
      expect(projection).toMatchObject({
        schema: "public-event/durable-publication-release-v2",
        event: { slug: releaseReference },
        release: {
          releaseReference,
          audience: "PUBLIC",
        },
      });
      const serialized = JSON.stringify(projection);
      expect(serialized).not.toContain("canonical_email");
      expect(serialized).not.toContain("@northstar");
      expect(serialized).not.toContain(seeded.workspaceId);
      expect(serialized).not.toContain(seeded.eventId);
      expect(serialized).not.toContain(seeded.release.releaseId);
      expect(serialized).not.toContain(seeded.release.fingerprint);
      expect(serialized).not.toContain(seeded.programUnitId);
      expect(serialized).not.toContain(seeded.personId);
      expect(projection?.sessions.every((session) => session.slug.startsWith("aud1-"))).toBe(true);
      expect(projection?.speakers.every((speaker) => speaker.slug.startsWith("aud1-"))).toBe(true);
      expect(projection?.redaction.omittedFields).toContain("Email addresses");
      expect(projection?.sessions.length).toBeGreaterThan(0);
      expect(projection?.speakers.length).toBeGreaterThan(0);
    } finally {
      closeDb(reloadedDb);
    }
  });

  it("fails closed for wrong-workspace reads, stale current pointers, malformed references, and tampered sealed content", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const seeded = seedSealedRelease(db);
      const foreignWorkspace = getWorkspaceBySlug(db, "acme");
      expect(foreignWorkspace).not.toBeNull();
      expect(validatePublicReleaseForRead(db, {
        workspaceId: foreignWorkspace!.id,
        eventId: seeded.eventId,
        releaseId: seeded.release.releaseId,
        mode: "CURRENT",
      })).toBeNull();
      expect(resolveCurrentDurablePublicAgenda(db, "not-a-release-fingerprint")).toBeNull();
      const releaseReference = publicReleaseReference({
        workspaceId: seeded.workspaceId,
        eventId: seeded.eventId,
        releaseId: seeded.release.releaseId,
      });

      expect(sealRelease(db, seeded.workspaceId, seeded.eventId, {
        kind: "account",
        ref: (db.prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY created_at LIMIT 1").get(seeded.workspaceId) as { id: string }).id,
      })).toMatchObject({
        releaseId: seeded.release.releaseId,
        fingerprint: seeded.release.fingerprint,
        created: false,
      });

      db.exec("DROP TRIGGER IF EXISTS trg_events_pointer_guard");
      db.prepare("UPDATE events SET current_release_id = NULL WHERE workspace_id = ? AND id = ?").run(seeded.workspaceId, seeded.eventId);
      expect(resolveCurrentDurablePublicAgenda(db, releaseReference)).toBeNull();

      db.prepare("UPDATE events SET current_release_id = ? WHERE workspace_id = ? AND id = ?").run(seeded.release.releaseId, seeded.workspaceId, seeded.eventId);
      db.exec("DROP TRIGGER IF EXISTS trg_releases_immutable");
      const row = db.prepare("SELECT content_json AS content FROM publication_releases WHERE id = ?").get(seeded.release.releaseId) as { content: string };
      const tampered = JSON.parse(row.content) as Record<string, unknown>;
      (tampered.event as Record<string, unknown>).name = "Forged public event";
      db.prepare("UPDATE publication_releases SET content_json = ? WHERE id = ?").run(JSON.stringify(tampered), seeded.release.releaseId);
      expect(resolveCurrentDurablePublicAgenda(db, releaseReference)).toBeNull();
    } finally {
      closeDb(db);
    }
  });
});
