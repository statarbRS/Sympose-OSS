import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSession, type SessionInfo } from "@/server/auth";
import { deterministicUuid } from "@/server/canonical";
import { closeDb, openDb, type Db } from "@/server/db";
import { seedWorkspaces } from "@/server/seed";
import { freezeCohortSnapshot } from "@/server/services/cohorts";
import {
  commitmentResponseCommandKey,
  deliverOffers,
  nextPendingOffer,
  respondToOfferCommand,
} from "@/server/services/commitments";
import { createEventWithUnit } from "@/server/services/events";
import { approvePlan, compilePlan } from "@/server/services/planning";
import {
  bindPublicationAudienceRelease,
  catalogCurrentPublicationRelease,
  createPublicationAudienceChannel,
  createPublicationAudiencePolicyVersion,
  disablePublicationAudienceBinding,
  disablePublicationAudienceChannel,
  getPublicationAudienceMatrix,
  PublicationAudienceServiceError,
  supersedePublicationAudiencePolicy,
} from "@/server/services/publication-audience";
import { sealRelease } from "@/server/services/publication";
import { getWorkspaceBySlug } from "@/server/services/queries";
import { createSyntheticSpeakerOperationsRepository } from "@/server/services/speaker-operations";
import { importFixtureEvidence } from "@/server/services/sources";
import { persistAndApproveCurrentSchedule } from "../helpers/schedule-approval";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("expected publication audience command to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PublicationAudienceServiceError);
    expect((error as PublicationAudienceServiceError).code).toBe(code);
  }
}

function seedValidatedRelease(db: Db): {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly session: SessionInfo;
  readonly releaseId: string;
  readonly releaseFingerprint: string;
} {
  const workspace = getWorkspaceBySlug(db, "northstar");
  if (!workspace) throw new Error("missing seeded workspace");
  const account = db.prepare(
    "SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' ORDER BY created_at, id LIMIT 1",
  ).get(workspace.id) as { id: string } | undefined;
  if (!account) throw new Error("missing seeded organizer");
  const actor = { kind: "account" as const, ref: account.id };

  importFixtureEvidence(db, workspace.id, workspace.slug);
  freezeCohortSnapshot(db, workspace.id, actor);
  const event = createEventWithUnit(db, workspace.id, actor, {
    eventName: "Publication audience authority event",
    unitName: "Audience authority session",
  });
  const plan = compilePlan(db, workspace.id, event.eventId, actor);
  approvePlan(db, workspace.id, event.eventId, plan.planVersionId, null, actor);
  deliverOffers(db, workspace.id, event.eventId, actor);
  const offer = nextPendingOffer(db, workspace.id, event.eventId);
  if (!offer) throw new Error("missing commitment offer");
  const terms = JSON.parse(offer.termsJson) as { readonly role?: unknown };
  const roleKey = terms.role === "MODERATOR" || terms.role === "moderator"
    ? "MODERATOR"
    : terms.role === "SPEAKER" || terms.role === "participant"
      ? "SPEAKER"
      : null;
  if (!roleKey) throw new Error("unsupported speaker role");
  respondToOfferCommand(db, workspace.id, event.eventId, {
    offerId: offer.id,
    response: "accepted",
    commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
  });

  const seededAt = "2026-08-13T01:00:00.000Z";
  const roomId = deterministicUuid(`publication-audience:room:${event.eventId}`);
  const trackId = deterministicUuid(`publication-audience:track:${event.eventId}`);
  const allocationId = deterministicUuid(`publication-audience:allocation:${event.eventId}`);
  const unit = db.prepare(
    `SELECT starts_at AS startsAt, ends_at AS endsAt
     FROM program_units WHERE workspace_id = ? AND event_id = ? AND id = ?`,
  ).get(workspace.id, event.eventId, event.programUnitId) as { startsAt: string; endsAt: string };
  db.prepare(
    `INSERT INTO event_rooms (id, workspace_id, event_id, name, capacity, created_at)
     VALUES (?, ?, ?, 'Audience room', 20, ?)`,
  ).run(roomId, workspace.id, event.eventId, seededAt);
  db.prepare(
    `INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at)
     VALUES (?, ?, ?, 'Audience track', 'audience-track', ?)`,
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
    deterministicUuid(`publication-audience:speaker:${event.eventId}`),
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
    title: "Audience session title",
    description: "Exact approved publication title.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2026-09-01T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: `publication-audience:title-task:${event.eventId}`,
  });
  const abstractTask = speaker.createTask(speakerScope, {
    personId: offer.personId,
    kind: "SESSION_DESCRIPTION",
    contentKind: "SESSION_DESCRIPTION",
    title: "Audience session abstract",
    description: "Exact approved publication abstract.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2026-09-01T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: `publication-audience:abstract-task:${event.eventId}`,
  });
  const title = speaker.submitOrganizerContent(speakerScope, {
    personId: offer.personId,
    taskId: titleTask.id,
    payload: { kind: "SESSION_TITLE", title: "Versioned audience authority" },
    idempotencyKey: `publication-audience:title-version:${event.eventId}`,
  });
  const abstract = speaker.submitOrganizerContent(speakerScope, {
    personId: offer.personId,
    taskId: abstractTask.id,
    payload: { kind: "SESSION_DESCRIPTION", description: "Append-only audience authority evidence." },
    idempotencyKey: `publication-audience:abstract-version:${event.eventId}`,
  });
  speaker.approveContent(speakerScope, {
    personId: offer.personId,
    taskId: titleTask.id,
    submissionVersionId: title.id,
    submissionContentHash: title.contentHash,
    gate: "PUBLICATION",
    idempotencyKey: `publication-audience:title-approval:${event.eventId}`,
  });
  speaker.approveContent(speakerScope, {
    personId: offer.personId,
    taskId: abstractTask.id,
    submissionVersionId: abstract.id,
    submissionContentHash: abstract.contentHash,
    gate: "PUBLICATION",
    idempotencyKey: `publication-audience:abstract-approval:${event.eventId}`,
  });
  persistAndApproveCurrentSchedule(
    db,
    { workspaceId: workspace.id, eventId: event.eventId },
    account.id,
    `publication-audience-${event.eventId}`,
  );

  const release = sealRelease(db, workspace.id, event.eventId, actor);
  const session = createSession(db, account.id, workspace.id).session;
  return {
    workspaceId: workspace.id,
    eventId: event.eventId,
    accountId: account.id,
    session,
    releaseId: release.releaseId,
    releaseFingerprint: release.fingerprint,
  };
}

function setup(db: Db) {
  seedWorkspaces(db);
  return seedValidatedRelease(db);
}

function createChannel(db: Db, session: SessionInfo, eventId: string, key = "public-agenda") {
  return createPublicationAudienceChannel(db, session, {
    eventId,
    key,
    label: key === "public-agenda" ? "Public agenda" : `${key} audience`,
    purpose: "EVENT_AGENDA",
    audience: "PUBLIC",
    visibility: "PUBLIC",
    idempotencyKey: `create-${key}`,
  });
}

describe("durable publication audience authority", () => {
  it("denies wrong roles and tenants without partial audience writes or pointer effects", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      const fixture = setup(db);
      const pointerBefore = db.prepare(
        "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(fixture.workspaceId, fixture.eventId);
      db.prepare(
        `INSERT INTO accounts
           (id, workspace_id, email, display_name, role, created_at)
         VALUES ('publication-read-only', ?, 'readonly@publication.test', 'Read only', 'read_only', ?)`,
      ).run(fixture.workspaceId, "2026-08-13T01:05:00.000Z");
      const readOnly = createSession(db, "publication-read-only", fixture.workspaceId).session;
      expectCode(() => createChannel(db, readOnly, fixture.eventId), "ACCESS_DENIED");

      const acme = getWorkspaceBySlug(db, "acme");
      if (!acme) throw new Error("missing foreign workspace");
      const acmeAccount = db.prepare(
        "SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer' ORDER BY id LIMIT 1",
      ).get(acme.id) as { id: string } | undefined;
      if (!acmeAccount) throw new Error("missing foreign organizer");
      const foreign = createSession(db, acmeAccount.id, acme.id).session;
      expectCode(() => createChannel(db, foreign, fixture.eventId), "EVENT_NOT_AVAILABLE");

      expect(db.prepare("SELECT COUNT(*) AS count FROM publication_audience_channels").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM publication_audience_receipts").get()).toEqual({ count: 0 });
      expect(db.prepare(
        "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(fixture.workspaceId, fixture.eventId)).toEqual(pointerBefore);
    } finally {
      closeDb(db);
    }
  });

  it("enforces exact release CAS, idempotency, stale non-reuse, and explicit blocking receipts", () => {
    const db = openDb({ path: ":memory:", seed: false });
    try {
      const fixture = setup(db);
      const pointerBefore = fixture.releaseId;
      const releaseVersion = catalogCurrentPublicationRelease(db, fixture.session, { eventId: fixture.eventId });
      const channel = createChannel(db, fixture.session, fixture.eventId);
      const replay = createChannel(db, fixture.session, fixture.eventId);
      expect(replay.receipt).toMatchObject({ id: channel.receipt.id, replayed: true });
      expectCode(() => createPublicationAudienceChannel(db, fixture.session, {
        eventId: fixture.eventId,
        key: "public-agenda",
        label: "Changed label",
        purpose: "EVENT_AGENDA",
        audience: "PUBLIC",
        visibility: "PUBLIC",
        idempotencyKey: "create-public-agenda",
      }), "IDEMPOTENCY_CONFLICT");

      const policy = createPublicationAudiencePolicyVersion(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        rule: "PUBLIC_SCHEDULE",
        idempotencyKey: "create-public-policy-v1",
      });
      expect(createPublicationAudiencePolicyVersion(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        rule: "PUBLIC_SCHEDULE",
        idempotencyKey: "create-public-policy-v1",
      }).receipt.replayed).toBe(true);

      const receiptCountBeforeMismatch = (db.prepare(
        "SELECT COUNT(*) AS count FROM publication_audience_receipts",
      ).get() as { count: number }).count;
      expectCode(() => bindPublicationAudienceRelease(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        policyVersionId: policy.policy.id,
        expectedReleaseId: fixture.releaseId,
        expectedReleaseVersion: releaseVersion.versionNumber + 1,
        expectedReleaseFingerprint: fixture.releaseFingerprint,
        idempotencyKey: "bind-wrong-version",
      }), "RELEASE_MISMATCH");
      expectCode(() => bindPublicationAudienceRelease(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        policyVersionId: policy.policy.id,
        expectedReleaseId: fixture.releaseId,
        expectedReleaseVersion: releaseVersion.versionNumber,
        expectedReleaseFingerprint: fixture.releaseFingerprint.startsWith("a")
          ? `b${fixture.releaseFingerprint.slice(1)}`
          : `a${fixture.releaseFingerprint.slice(1)}`,
        idempotencyKey: "bind-wrong-fingerprint",
      }), "RELEASE_MISMATCH");
      expect(db.prepare("SELECT COUNT(*) AS count FROM publication_audience_receipts").get()).toEqual({
        count: receiptCountBeforeMismatch,
      });

      const binding = bindPublicationAudienceRelease(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        policyVersionId: policy.policy.id,
        expectedReleaseId: fixture.releaseId,
        expectedReleaseVersion: releaseVersion.versionNumber,
        expectedReleaseFingerprint: fixture.releaseFingerprint,
        idempotencyKey: "bind-public-release-v1",
      });
      expect(bindPublicationAudienceRelease(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        policyVersionId: policy.policy.id,
        expectedReleaseId: fixture.releaseId,
        expectedReleaseVersion: releaseVersion.versionNumber,
        expectedReleaseFingerprint: fixture.releaseFingerprint,
        idempotencyKey: "bind-public-release-v1",
      })).toMatchObject({ id: binding.id, replayed: true });
      expect(getPublicationAudienceMatrix(db, fixture.session, { eventId: fixture.eventId }).rows[0]).toMatchObject({
        status: "CURRENT",
        bindingReceiptId: binding.id,
      });

      db.prepare(
        "UPDATE events SET current_release_id = NULL WHERE workspace_id = ? AND id = ?",
      ).run(fixture.workspaceId, fixture.eventId);
      expect(getPublicationAudienceMatrix(db, fixture.session, { eventId: fixture.eventId }).rows[0]?.status).toBe("SUPERSEDED");
      expectCode(() => bindPublicationAudienceRelease(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        policyVersionId: policy.policy.id,
        expectedReleaseId: fixture.releaseId,
        expectedReleaseVersion: releaseVersion.versionNumber,
        expectedReleaseFingerprint: fixture.releaseFingerprint,
        idempotencyKey: "stale-release-reuse",
      }), "RELEASE_UNAVAILABLE");

      disablePublicationAudienceBinding(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        bindingReceiptId: binding.id,
        expectedReleaseId: fixture.releaseId,
        expectedReleaseVersion: releaseVersion.versionNumber,
        expectedReleaseFingerprint: fixture.releaseFingerprint,
        idempotencyKey: "disable-binding-v1",
      });
      expect(getPublicationAudienceMatrix(db, fixture.session, { eventId: fixture.eventId }).rows[0]?.status).toBe("BLOCKED");

      const successor = createPublicationAudiencePolicyVersion(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        rule: "ACCEPTED_AGENDAS",
        idempotencyKey: "create-public-policy-v2",
      });
      supersedePublicationAudiencePolicy(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        policyVersionId: policy.policy.id,
        expectedPolicyFingerprint: policy.policy.policyFingerprint,
        successorPolicyVersionId: successor.policy.id,
        expectedSuccessorPolicyFingerprint: successor.policy.policyFingerprint,
        idempotencyKey: "supersede-public-policy-v1",
      });
      disablePublicationAudienceChannel(db, fixture.session, {
        eventId: fixture.eventId,
        channelId: channel.channel.id,
        expectedChannelFingerprint: channel.channel.fingerprint,
        idempotencyKey: "disable-public-channel",
      });
      const historical = getPublicationAudienceMatrix(db, fixture.session, { eventId: fixture.eventId });
      expect(historical.rows[0]).toMatchObject({ status: "BLOCKED", bindingReceiptId: binding.id });
      expect(historical.receipts.map((receipt) => receipt.action)).toEqual([
        "CHANNEL_CREATED",
        "POLICY_DRAFTED",
        "RELEASE_BOUND",
        "BINDING_DISABLED",
        "POLICY_DRAFTED",
        "POLICY_SUPERSEDED",
        "CHANNEL_DISABLED",
      ]);
      expect(db.prepare(
        "SELECT current_release_id AS currentReleaseId FROM events WHERE workspace_id = ? AND id = ?",
      ).get(fixture.workspaceId, fixture.eventId)).toEqual({ currentReleaseId: null });
      expect(pointerBefore).toBe(fixture.releaseId);
    } finally {
      closeDb(db);
    }
  });

  it("persists across reload and projects the same order with reverse unordered selects", () => {
    const directory = mkdtempSync(join(process.cwd(), ".publication-audience-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sympose.db");
    const first = openDb({ path, seed: false });
    const fixture = setup(first);
    const release = catalogCurrentPublicationRelease(first, fixture.session, { eventId: fixture.eventId });
    const zeta = createChannel(first, fixture.session, fixture.eventId, "zeta");
    const alpha = createChannel(first, fixture.session, fixture.eventId, "alpha");
    const policy = createPublicationAudiencePolicyVersion(first, fixture.session, {
      eventId: fixture.eventId,
      channelId: alpha.channel.id,
      rule: "PUBLIC_SCHEDULE",
      idempotencyKey: "alpha-policy-v1",
    });
    bindPublicationAudienceRelease(first, fixture.session, {
      eventId: fixture.eventId,
      channelId: alpha.channel.id,
      policyVersionId: policy.policy.id,
      expectedReleaseId: fixture.releaseId,
      expectedReleaseVersion: release.versionNumber,
      expectedReleaseFingerprint: fixture.releaseFingerprint,
      idempotencyKey: "alpha-release-v1",
    });
    const baseline = getPublicationAudienceMatrix(first, fixture.session, { eventId: fixture.eventId });
    expect(baseline.channels.map((channel) => channel.key)).toEqual(["alpha", "zeta"]);
    expect(baseline.rows.map((row) => [row.channelKey, row.status])).toEqual([
      ["alpha", "CURRENT"],
      ["zeta", "UNAVAILABLE"],
    ]);
    first.exec("PRAGMA reverse_unordered_selects = ON");
    expect(getPublicationAudienceMatrix(first, fixture.session, { eventId: fixture.eventId }).fingerprint).toBe(baseline.fingerprint);
    expect(catalogCurrentPublicationRelease(first, fixture.session, { eventId: fixture.eventId }).id).toBe(release.id);
    expect(zeta.channel.key).toBe("zeta");
    closeDb(first);

    const reloaded = openDb({ path, seed: false });
    try {
      const projection = getPublicationAudienceMatrix(reloaded, fixture.session, { eventId: fixture.eventId });
      expect(projection.fingerprint).toBe(baseline.fingerprint);
      expect(projection.currentReleaseId).toBe(fixture.releaseId);
      expect(projection.currentReleaseValidated).toBe(true);
      expect(projection.receipts).toHaveLength(4);
      expect(() => reloaded.prepare("UPDATE publication_audience_channels SET label = 'mutated'").run()).toThrow(/immutable/u);
      expect(() => reloaded.prepare("DELETE FROM publication_audience_receipts").run()).toThrow(/retained/u);
    } finally {
      closeDb(reloaded);
    }
  });
});
