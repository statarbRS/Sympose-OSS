import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { type SessionInfo } from "../../src/server/auth";
import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  appendProgramCapacityPoolVersion,
  createProgramCapacityPool,
  getProgramCapacityLedger,
  getProgramCapacitySurfaceProjection,
  CapacitySurfaceProjectionError,
  CAPACITY_SURFACE_HISTORY_LIMIT,
  CAPACITY_SURFACE_POOL_LIMIT,
  CAPACITY_SURFACE_VERSION_LIMIT,
  listProgramCapacityTransferHistory,
  releaseProgramCapacity,
  transferProgramCapacity,
} from "../../src/server/services/program-capacity";

const EVENT_ID = "capacity-event";
const EVENT_TIME = "2026-09-15T09:00:00.000Z";

function fixture(): { db: Db; session: SessionInfo; workspaceId: string; eventId: string } {
  const db = openDb({ path: ":memory:" });
  const workspaceId = (db.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as { id: string }).id;
  const accountId = (db.prepare("SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer'").get(workspaceId) as { id: string }).id;
  db.prepare(`INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
    VALUES (?, ?, 'Capacity event', 'UTC', ?, ?, '2026-08-10T00:00:00.000Z')`)
    .run(EVENT_ID, workspaceId, EVENT_TIME, "2026-09-15T10:00:00.000Z");
  db.prepare(`INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at)
    VALUES ('session-capacity', 'token-hash', ?, ?, '2026-08-10T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`).run(accountId, workspaceId);
  return {
    db,
    workspaceId,
    eventId: EVENT_ID,
    session: {
      id: "session-capacity", tokenHash: "token-hash", accountId, workspaceId,
      expiresAt: "2099-01-01T00:00:00.000Z", email: "organizer@northstar.example",
      displayName: "Northstar Organizer", role: "organizer", workspaceSlug: "northstar", workspaceName: "Northstar Network",
    },
  };
}

function closeFixture(data: { db: Db }): void {
  closeDb(data.db);
}

describe("PD-01 typed capacity services", () => {
  it("reads one bounded, workspace/event-authorized surface snapshot with sequence-consistent families", () => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "surface-source", versionId: "surface-source-v1", name: "Surface source", unitKind: "SEAT", capacity: 20, effectiveFrom: EVENT_TIME });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "surface-destination", versionId: "surface-destination-v1", name: "Surface destination", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      transferProgramCapacity(data.db, data.session, data.eventId, {
        sourcePoolId: source.pool.id, sourcePoolVersionId: source.version.id, destinationPoolId: destination.pool.id,
        destinationPoolVersionId: destination.version.id, unitKind: "SEAT", quantity: 3,
        reason: "surface snapshot", approvalReference: "surface-approval", idempotencyKey: "surface-transfer",
      });
      const projection = getProgramCapacitySurfaceProjection(data.db, data.session, data.eventId);
      expect(projection.ledger.sequenceNumber).toBe(1);
      expect(projection.history).toHaveLength(1);
      expect(projection.history[0].sequenceNumber).toBe(projection.ledger.sequenceNumber);
      expect(projection.history[0].eventId).toBe(data.eventId);
      expect(projection.pools.every((pool) => pool.workspaceId === data.workspaceId && pool.eventId === data.eventId)).toBe(true);
      expect(projection.history[0].receiptId).toBe("receipt:" + projection.history[0].decisionId);
    } finally {
      closeFixture(data);
    }
  });

  it("preserves production authorization and event/workspace boundaries for the UI projection", () => {
    const data = fixture();
    try {
      expect(() => getProgramCapacitySurfaceProjection(data.db, { ...data.session, workspaceId: "other-workspace" }, data.eventId)).toThrow(/SESSION_INVALID/);
      expect(() => getProgramCapacitySurfaceProjection(data.db, data.session, "wrong-event")).toThrow(/EVENT_NOT_FOUND/);
      data.db.prepare("UPDATE accounts SET role = 'read_only' WHERE id = ?").run(data.session.accountId);
      expect(() => getProgramCapacitySurfaceProjection(data.db, { ...data.session, role: "read_only" }, data.eventId)).toThrow(/CAPABILITY_DENIED|not authorized/);
    } finally {
      closeFixture(data);
    }
  });

  it("fails typed before materializing over-limit pool or receipt families", () => {
    const poolData = fixture();
    try {
      for (let index = 0; index <= CAPACITY_SURFACE_POOL_LIMIT; index += 1) {
        createProgramCapacityPool(poolData.db, poolData.session, poolData.eventId, { poolId: `surface-pool-${index}`, name: `Surface pool ${index}`, unitKind: "SEAT", capacity: 1, effectiveFrom: EVENT_TIME });
      }
      expect(() => getProgramCapacitySurfaceProjection(poolData.db, poolData.session, poolData.eventId)).toThrow(CapacitySurfaceProjectionError);
      expect(() => getProgramCapacitySurfaceProjection(poolData.db, poolData.session, poolData.eventId)).toThrow(/CAPACITY_SURFACE_OVERFLOW/);
    } finally {
      closeFixture(poolData);
    }

    const historyData = fixture();
    try {
      const source = createProgramCapacityPool(historyData.db, historyData.session, historyData.eventId, { poolId: "history-source", name: "History source", unitKind: "SEAT", capacity: CAPACITY_SURFACE_HISTORY_LIMIT + 2, effectiveFrom: EVENT_TIME });
      const destination = createProgramCapacityPool(historyData.db, historyData.session, historyData.eventId, { poolId: "history-destination", name: "History destination", unitKind: "SEAT", capacity: CAPACITY_SURFACE_HISTORY_LIMIT + 2, effectiveFrom: EVENT_TIME });
      for (let index = 0; index <= CAPACITY_SURFACE_HISTORY_LIMIT; index += 1) {
        transferProgramCapacity(historyData.db, historyData.session, historyData.eventId, {
          sourcePoolId: source.pool.id, destinationPoolId: destination.pool.id, unitKind: "SEAT", quantity: 1,
          reason: "bounded history", approvalReference: "history-approval", idempotencyKey: `history-${index}`,
        });
      }
      expect(() => getProgramCapacitySurfaceProjection(historyData.db, historyData.session, historyData.eventId)).toThrow(/CAPACITY_SURFACE_OVERFLOW/);
    } finally {
      closeFixture(historyData);
    }
  });

  it("probes immutable versions before the ledger materializer can read them", () => {
    const data = fixture();
    try {
      const pool = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "version-overflow", name: "Version overflow", unitKind: "SEAT", capacity: 1, effectiveFrom: EVENT_TIME,
      });
      for (let versionNumber = 2; versionNumber <= CAPACITY_SURFACE_VERSION_LIMIT + 1; versionNumber += 1) {
        const scope = { versionNumber };
        const eligibility = { audience: "all" };
        const reservedFor = null;
        const releasePolicy = { allowUnsoldRelease: false };
        const createdAt = `2026-08-11T10:${String(versionNumber % 60).padStart(2, "0")}:00.000Z`;
        const fingerprint = fingerprintOf({ schema: "pd01-capacity-pool-version/v1", workspaceId: data.workspaceId,
          eventId: data.eventId, poolId: pool.pool.id, versionNumber, unitKind: "SEAT", capacity: 1, scope,
          eligibility, reservedFor, releasePolicy, effectiveFrom: EVENT_TIME, effectiveTo: null, createdAt });
        data.db.prepare(`INSERT INTO program_capacity_pool_versions
          (id, workspace_id, event_id, pool_id, version_number, unit_kind, capacity, scope_json,
           eligibility_json, reserved_for_json, release_policy_json, effective_from, effective_to, fingerprint, created_at)
          VALUES (?, ?, ?, ?, ?, 'SEAT', 1, ?, ?, ?, ?, ?, NULL, ?, ?)`)
          .run(`version-overflow-v${versionNumber}`, data.workspaceId, data.eventId, pool.pool.id, versionNumber,
            canonicalJson(scope), canonicalJson(eligibility), canonicalJson(reservedFor), canonicalJson(releasePolicy), EVENT_TIME, fingerprint, createdAt);
      }
      expect(() => getProgramCapacitySurfaceProjection(data.db, data.session, data.eventId)).toThrow(/CAPACITY_SURFACE_OVERFLOW/);
    } finally {
      closeFixture(data);
    }
  });

  it("propagates receipt integrity failure through the projection", () => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "integrity-source", name: "Integrity source", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "integrity-destination", name: "Integrity destination", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      const transfer = transferProgramCapacity(data.db, data.session, data.eventId, { sourcePoolId: source.pool.id, destinationPoolId: destination.pool.id, unitKind: "SEAT", quantity: 1, reason: "integrity fixture", approvalReference: "integrity-approval", idempotencyKey: "integrity-transfer" });
      data.db.exec("DROP TRIGGER trg_capacity_transfer_receipts_immutable");
      data.db.prepare("UPDATE capacity_transfer_receipts SET fingerprint = ? WHERE id = ?").run("f".repeat(64), transfer.receipt.receiptId);
      expect(() => getProgramCapacitySurfaceProjection(data.db, data.session, data.eventId)).toThrow(/CAPACITY_RECEIPT_CORRUPT|CAPACITY_LEDGER_CORRUPT/);
    } finally {
      closeFixture(data);
    }
  });

  it("accepts a legitimate historical receipt after a newer immutable pool version", () => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "historical-source", versionId: "historical-source-v1", name: "Historical source", unitKind: "SEAT", capacity: 10, effectiveFrom: EVENT_TIME,
      });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "historical-destination", versionId: "historical-destination-v1", name: "Historical destination", unitKind: "SEAT", capacity: 1, effectiveFrom: EVENT_TIME,
      });
      const transfer = transferProgramCapacity(data.db, data.session, data.eventId, {
        sourcePoolId: source.pool.id, sourcePoolVersionId: source.version.id, destinationPoolId: destination.pool.id,
        destinationPoolVersionId: destination.version.id, unitKind: "SEAT", quantity: 2,
        reason: "historical receipt", approvalReference: "historical-approval", idempotencyKey: "historical-transfer",
      });
      const scope = { track: "historical-v2" };
      const eligibility = { audience: "all" };
      const reservedFor = null;
      const releasePolicy = { allowUnsoldRelease: false };
      const createdAt = "2026-08-11T10:00:00.000Z";
      const fingerprint = fingerprintOf({
        schema: "pd01-capacity-pool-version/v1", workspaceId: data.workspaceId, eventId: data.eventId,
        poolId: source.pool.id, versionNumber: 2, unitKind: "SEAT", capacity: 12, scope, eligibility,
        reservedFor, releasePolicy, effectiveFrom: EVENT_TIME, effectiveTo: null, createdAt,
      });
      data.db.prepare(`INSERT INTO program_capacity_pool_versions
        (id, workspace_id, event_id, pool_id, version_number, unit_kind, capacity, scope_json,
         eligibility_json, reserved_for_json, release_policy_json, effective_from, effective_to, fingerprint, created_at)
        VALUES (?, ?, ?, ?, 2, 'SEAT', 12, ?, ?, ?, ?, ?, NULL, ?, ?)`)
        .run("historical-source-v2", data.workspaceId, data.eventId, source.pool.id,
          canonicalJson(scope), canonicalJson(eligibility), canonicalJson(reservedFor), canonicalJson(releasePolicy), EVENT_TIME, fingerprint, createdAt);

      const projection = getProgramCapacitySurfaceProjection(data.db, data.session, data.eventId);
      expect(projection.pools.find((pool) => pool.id === source.pool.id)?.currentVersion.id).toBe("historical-source-v2");
      expect(projection.history[0]).toMatchObject({
        decisionId: transfer.decisionId, sourcePoolVersionId: source.version.id,
        destinationPoolVersionId: destination.version.id,
      });
    } finally {
      closeFixture(data);
    }
  });

  it("bounds duplicate audit evidence and rejects it as integrity corruption", () => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "audit-source", name: "Audit source", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "audit-destination", name: "Audit destination", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      const transfer = transferProgramCapacity(data.db, data.session, data.eventId, {
        sourcePoolId: source.pool.id, destinationPoolId: destination.pool.id, unitKind: "SEAT", quantity: 1,
        reason: "duplicate audit fixture", approvalReference: "duplicate-audit-approval", idempotencyKey: "duplicate-audit-transfer",
      });
      const audit = data.db.prepare(`SELECT actor_kind AS actorKind, actor_ref AS actorRef, action, target_type AS targetType,
          target_id AS targetId, details_json AS detailsJson, created_at AS createdAt
          FROM audit_events WHERE workspace_id = ? AND target_id = ? LIMIT 1`)
        .get(data.workspaceId, transfer.decisionId) as { actorKind: string; actorRef: string; action: string; targetType: string; targetId: string; detailsJson: string; createdAt: string };
      data.db.prepare(`INSERT INTO audit_events
        (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("duplicate-capacity-audit", data.workspaceId, audit.actorKind, audit.actorRef, audit.action,
          audit.targetType, audit.targetId, audit.detailsJson, audit.createdAt);
      expect(() => getProgramCapacitySurfaceProjection(data.db, data.session, data.eventId)).toThrow(/CAPACITY_AUDIT_CORRUPT/);
    } finally {
      closeFixture(data);
    }
  });

  it("creates stable main/sponsor pools, appends an immutable version, transfers explicitly, and releases unsold capacity", () => {
    const data = fixture();
    try {
      const main = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "main", versionId: "main-v1", name: "Main", unitKind: "SEAT", capacity: 10,
        scope: { track: "main" }, eligibility: { audience: "all" }, reservedFor: null,
        releasePolicy: { allowUnsoldRelease: false }, effectiveFrom: EVENT_TIME,
      });
      const mainV2 = appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, {
        poolId: "main", idempotencyKey: "main-v2-append", versionId: "main-v2", capacity: 10, scope: { track: "main-v2" },
        eligibility: { audience: "all" }, reservedFor: null, releasePolicy: { allowUnsoldRelease: false },
        effectiveFrom: EVENT_TIME, expectedVersionNumber: 1,
      });
      const sponsor = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "sponsor", versionId: "sponsor-v1", name: "Sponsor", unitKind: "SEAT", capacity: 3,
        reservedFor: { sponsorId: "acme" }, releasePolicy: { mode: "RELEASE_UNSOLD" }, effectiveFrom: EVENT_TIME,
      });
      expect(main.created).toBe(true);
      expect(mainV2.version.versionNumber).toBe(2);
      expect(createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "main", name: "Main", unitKind: "SEAT", capacity: 10, scope: { track: "main" },
        eligibility: { audience: "all" }, reservedFor: null, releasePolicy: { allowUnsoldRelease: false }, effectiveFrom: EVENT_TIME,
      }).created).toBe(false);

      const transfer = transferProgramCapacity(data.db, data.session, data.eventId, {
        sourcePoolId: "main", sourcePoolVersionId: mainV2.version.id, destinationPoolId: "sponsor",
        destinationPoolVersionId: sponsor.version.id, unitKind: "SEAT", quantity: 2,
        reason: "approved sponsor allocation", approvalReference: "approval-1", idempotencyKey: "transfer-1",
      });
      expect(transfer.receipt).toMatchObject({ sourceBefore: 10, sourceAfter: 8, destinationBefore: 3, destinationAfter: 5,
        sourcePoolVersionId: "main-v2", destinationPoolVersionId: "sponsor-v1", quantity: 2 });
      expect(transfer.receipt.receiptId).toBe(`receipt:${transfer.decisionId}`);
      expect(transfer.receipt.fingerprint).toBe(transfer.receipt.fingerprint);

      const release = releaseProgramCapacity(data.db, data.session, data.eventId, {
        sourcePoolId: "sponsor", sourcePoolVersionId: sponsor.version.id, destinationPoolId: "main",
        destinationPoolVersionId: mainV2.version.id, unitKind: "SEAT", quantity: 1,
        reason: "unsold sponsor allocation", approvalReference: "approval-release-1", idempotencyKey: "release-1",
      });
      expect(release.operation).toBe("release");
      expect(release.receipt).toMatchObject({ sourceBefore: 5, sourceAfter: 4, destinationBefore: 8, destinationAfter: 9 });
      const ledger = getProgramCapacityLedger(data.db, data.session, data.eventId);
      expect(ledger.sequenceNumber).toBe(2);
      expect(ledger.totalCapacity).toBe(13);
      expect(ledger.totalRemaining).toBe(13);
      expect(ledger.pools).toEqual(expect.arrayContaining([
        expect.objectContaining({ poolId: "main", versionId: "main-v2", remaining: 9, remainingCapacity: 9 }),
        expect.objectContaining({ poolId: "sponsor", remaining: 4 }),
      ]));
      expect(listProgramCapacityTransferHistory(data.db, data.session, data.eventId).map((row) => row.sequenceNumber)).toEqual([1, 2]);
      expect((data.db.prepare("SELECT COUNT(*) AS n FROM capacity_transfer_receipts").get() as { n: number }).n).toBe(2);
    } finally {
      closeFixture(data);
    }
  });

  it("derives arithmetic, rejects overdraft/type/root/version errors, and preserves exact replay results", () => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "source", versionId: "source-v1", name: "Source", unitKind: "SEAT", capacity: 5, effectiveFrom: EVENT_TIME,
      });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "destination", versionId: "destination-v1", name: "Destination", unitKind: "SEAT", capacity: 1, effectiveFrom: EVENT_TIME,
      });
      const input = {
        sourcePoolId: "source", sourcePoolVersionId: source.version.id, destinationPoolId: "destination",
        destinationPoolVersionId: destination.version.id, unitKind: "SEAT" as const, quantity: 3,
        reason: "rebalance", approvalReference: "approval-1", idempotencyKey: "same-key",
      };
      const first = transferProgramCapacity(data.db, data.session, data.eventId, input);
      const replay = transferProgramCapacity(data.db, data.session, data.eventId, input);
      expect(replay).toEqual({ ...first, created: false, replayed: true });
      expect(() => transferProgramCapacity(data.db, data.session, data.eventId, { ...input, quantity: 2 })).toThrow(/IDEMPOTENCY_KEY_REUSE_CONFLICT/);
      expect(() => transferProgramCapacity(data.db, data.session, data.eventId, { ...input, idempotencyKey: "overdraft", quantity: 3 })).toThrow(/CAPACITY_OVERDRAFT/);
      expect(() => transferProgramCapacity(data.db, data.session, data.eventId, { ...input, idempotencyKey: "same-root", destinationPoolId: "source" })).toThrow(/SAME_POOL_ROOT/);
      expect(() => transferProgramCapacity(data.db, data.session, data.eventId, { ...input, idempotencyKey: "unit", unitKind: "HOUR" })).toThrow(/UNIT_KIND_MISMATCH/);
      expect(() => transferProgramCapacity(data.db, data.session, data.eventId, { ...input, idempotencyKey: "wrong-version", sourcePoolVersionId: "missing-version" })).toThrow(/POOL_VERSION_STALE/);
      expect(() => getProgramCapacityLedger(data.db, data.session, "wrong-event")).toThrow(/EVENT_NOT_FOUND/);
      const acmeWorkspaceId = (data.db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { id: string }).id;
      expect(() => getProgramCapacityLedger(data.db, { ...data.session, workspaceId: acmeWorkspaceId }, data.eventId)).toThrow(/SESSION_INVALID/);
      expect(() => transferProgramCapacity(data.db, data.session, data.eventId, { ...input, idempotencyKey: "decimal", quantity: 1.5 })).toThrow(/INVALID_QUANTITY/);
      expect(() => releaseProgramCapacity(data.db, data.session, data.eventId, { ...input, idempotencyKey: "release-denied", quantity: 1 })).toThrow(/RELEASE_POLICY_DENIED/);
    } finally {
      closeFixture(data);
    }
  });

  it("requires organizer capability while retaining only the permitted denial audit", () => {
    const data = fixture();
    try {
      data.db.prepare("UPDATE accounts SET role = 'read_only' WHERE id = ?").run(data.session.accountId);
      const denied = { ...data.session, role: "read_only" };
      const before = (data.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
      expect(() => createProgramCapacityPool(data.db, denied, data.eventId, {
        poolId: "denied", name: "Denied", unitKind: "SEAT", capacity: 1,
      })).toThrow(/not authorized/);
      expect((data.db.prepare("SELECT COUNT(*) AS n FROM program_capacity_pools").get() as { n: number }).n).toBe(0);
      expect((data.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n).toBe(before + 1);
    } finally {
      closeFixture(data);
    }
  });

  it("rejects stale expected sequence under two connections and remains stable across restart/VACUUM", () => {
    const path = ".tmp/unit/pd01-capacity-service.db";
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    const first = openDb({ path });
    const workspaceId = (first.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as { id: string }).id;
    const accountId = (first.prepare("SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer'").get(workspaceId) as { id: string }).id;
    first.prepare(`INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
      VALUES (?, ?, 'Capacity event', 'UTC', ?, ?, '2026-08-10T00:00:00.000Z')`).run(EVENT_ID, workspaceId, EVENT_TIME, "2026-09-15T10:00:00.000Z");
    first.prepare(`INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at)
      VALUES ('session-capacity', 'token-hash', ?, ?, '2026-08-10T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`).run(accountId, workspaceId);
    const session: SessionInfo = {
      id: "session-capacity", tokenHash: "token-hash", accountId, workspaceId, expiresAt: "2099-01-01T00:00:00.000Z",
      email: "organizer@northstar.example", displayName: "Northstar Organizer", role: "organizer", workspaceSlug: "northstar", workspaceName: "Northstar Network",
    };
    try {
      const source = createProgramCapacityPool(first, session, EVENT_ID, { poolId: "source", versionId: "source-v1", name: "Source", unitKind: "SEAT", capacity: 5, effectiveFrom: EVENT_TIME });
      const destination = createProgramCapacityPool(first, session, EVENT_ID, { poolId: "destination", versionId: "destination-v1", name: "Destination", unitKind: "SEAT", capacity: 1, effectiveFrom: EVENT_TIME });
      const second = openDb({ path, seed: false });
      try {
        const initial = getProgramCapacityLedger(second, session, EVENT_ID);
        const command = { sourcePoolId: "source", sourcePoolVersionId: source.version.id, destinationPoolId: "destination", destinationPoolVersionId: destination.version.id, unitKind: "SEAT", quantity: 1, reason: "rebalance", approvalReference: "approval", idempotencyKey: "connection-1", expectedSequenceNumber: initial.sequenceNumber, expectedLedgerFingerprint: initial.ledgerFingerprint };
        transferProgramCapacity(first, session, EVENT_ID, command);
        expect(() => transferProgramCapacity(second, session, EVENT_ID, { ...command, idempotencyKey: "connection-2" })).toThrow(/STALE_LEDGER/);
        const before = getProgramCapacityLedger(first, session, EVENT_ID);
        first.close();
        const raw = new DatabaseSync(path);
        raw.exec("VACUUM");
        raw.close();
        const reopened = openDb({ path, seed: false });
        try {
          expect(getProgramCapacityLedger(reopened, session, EVENT_ID)).toEqual(before);
        } finally {
          closeDb(reopened);
        }
      } finally {
        if (!second.isOpen) return;
        closeDb(second);
      }
    } finally {
      if (first.isOpen) closeDb(first);
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    }
  });

  it("rejects appending a definition after that pool has entered the transfer ledger", () => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "source", versionId: "source-v1", name: "Source", unitKind: "SEAT", capacity: 5, effectiveFrom: EVENT_TIME,
      });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "destination", versionId: "destination-v1", name: "Destination", unitKind: "SEAT", capacity: 1, effectiveFrom: EVENT_TIME,
      });
      transferProgramCapacity(data.db, data.session, data.eventId, {
        sourcePoolId: source.pool.id, destinationPoolId: destination.pool.id, unitKind: "SEAT", quantity: 1,
        reason: "approved", approvalReference: "approval", idempotencyKey: "append-after-transfer",
      });
      expect(() => appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, {
        poolId: source.pool.id, idempotencyKey: "append-after-transfer", capacity: 5, effectiveFrom: EVENT_TIME,
      })).toThrow(/POOL_VERSION_APPEND_AFTER_TRANSFER/);
      expect((data.db.prepare("SELECT COUNT(*) AS n FROM program_capacity_pool_versions WHERE pool_id = 'source'").get() as { n: number }).n).toBe(1);
    } finally {
      closeFixture(data);
    }
  });

  it("replays an append by explicit idempotency key and rejects a conflicting payload", () => {
    const data = fixture();
    try {
      createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "append", name: "Append", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      const input = { poolId: "append", idempotencyKey: "append-retry", versionId: "append-v2", capacity: 3, scope: { v: 2 }, effectiveFrom: EVENT_TIME, expectedVersionNumber: 1 };
      const first = appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, input);
      const replay = appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, input);
      expect(replay).toEqual({ ...first, created: false });
      expect(() => appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, { ...input, capacity: 4 })).toThrow(/APPEND_IDEMPOTENCY_KEY_REUSE_CONFLICT/);
      expect((data.db.prepare("SELECT COUNT(*) AS n FROM program_capacity_pool_versions WHERE pool_id = 'append'").get() as { n: number }).n).toBe(2);
    } finally {
      closeFixture(data);
    }
  });

  it("uses the persisted event start as the stable default for delayed omitted-effectiveFrom retries", async () => {
    const data = fixture();
    try {
      createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "delayed", name: "Delayed", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      const input = { poolId: "delayed", idempotencyKey: "delayed-append", versionId: "delayed-v2", capacity: 3, scope: { delayed: true }, expectedVersionNumber: 1 };
      const first = appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, input);
      await new Promise((resolve) => setTimeout(resolve, 15));
      const retry = appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, input);
      expect(retry).toEqual({ ...first, created: false });
      expect(retry.version.effectiveFrom).toBe(EVENT_TIME);
    } finally {
      closeFixture(data);
    }
  });

  it("reopens and replays canonical append evidence", () => {
    const path = ".tmp/unit/pd01-append-reopen.db";
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    const firstDb = openDb({ path });
    const workspaceId = (firstDb.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as { id: string }).id;
    const accountId = (firstDb.prepare("SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer'").get(workspaceId) as { id: string }).id;
    firstDb.prepare(`INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, 'Append reopen', 'UTC', ?, ?, '2026-08-10T00:00:00.000Z')`).run("append-reopen-event", workspaceId, EVENT_TIME, "2026-09-15T10:00:00.000Z");
    firstDb.prepare(`INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at) VALUES ('append-reopen-session', 'append-reopen-token', ?, ?, '2026-08-10T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`).run(accountId, workspaceId);
    const session: SessionInfo = { id: "append-reopen-session", tokenHash: "append-reopen-token", accountId, workspaceId, expiresAt: "2099-01-01T00:00:00.000Z", email: "organizer@northstar.example", displayName: "Northstar Organizer", role: "organizer", workspaceSlug: "northstar", workspaceName: "Northstar Network" };
    try {
      createProgramCapacityPool(firstDb, session, "append-reopen-event", { poolId: "reopen-pool", name: "Reopen pool", unitKind: "SEAT", capacity: 1, effectiveFrom: EVENT_TIME });
      const input = { poolId: "reopen-pool", idempotencyKey: "reopen-key", capacity: 2, scope: { reopen: true } };
      const first = appendProgramCapacityPoolVersion(firstDb, session, "append-reopen-event", input);
      closeDb(firstDb);
      const reopened = openDb({ path, seed: false });
      try {
        expect(appendProgramCapacityPoolVersion(reopened, session, "append-reopen-event", input)).toEqual({ ...first, created: false });
      } finally {
        closeDb(reopened);
      }
    } finally {
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    }
  });

  it("ignores unrelated malformed append audits but blocks relevant corruption", () => {
    const data = fixture();
    try {
      createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "audit-append", name: "Audit append", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      data.db.prepare(`INSERT INTO audit_events (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
        VALUES ('unrelated-malformed-append-audit', ?, 'account', ?, 'capacity.pool.version.appended', 'capacity_pool_append_command', 'unrelated-command', 'null', ?)`)
        .run(data.workspaceId, data.session.accountId, EVENT_TIME);
      const input = {
        poolId: "audit-append", idempotencyKey: "audit-append-key", versionId: "audit-append-v2", capacity: 3, effectiveFrom: EVENT_TIME,
      };
      expect(appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, input).created).toBe(true);

      data.db.exec("DROP TRIGGER trg_audit_immutable");
      data.db.prepare("UPDATE audit_events SET details_json = ? WHERE target_type = 'capacity_pool_append_command'")
        .run(JSON.stringify({ poolId: "audit-append", eventId: EVENT_ID }));
      expect(() => appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, input)).toThrow(/CAPACITY_AUDIT_CORRUPT/);
    } finally {
      closeFixture(data);
    }
  });

  it("rejects duplicate relevant append command evidence", () => {
    const data = fixture();
    try {
      createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "duplicate-append", name: "Duplicate append", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      const input = { poolId: "duplicate-append", idempotencyKey: "duplicate-append-key", versionId: "duplicate-append-v2", capacity: 3, effectiveFrom: EVENT_TIME };
      appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, input);
      const evidence = data.db.prepare("SELECT workspace_id AS workspaceId, actor_ref AS actorRef, target_id AS targetId, details_json AS detailsJson, created_at AS createdAt FROM audit_events WHERE target_type = 'capacity_pool_append_command'").get() as { workspaceId: string; actorRef: string; targetId: string; detailsJson: string; createdAt: string };
      data.db.prepare(`INSERT INTO audit_events (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
        VALUES ('duplicate-append-evidence', ?, 'account', ?, 'capacity.pool.version.appended', 'capacity_pool_append_command', ?, ?, ?)`)
        .run(evidence.workspaceId, evidence.actorRef, evidence.targetId, evidence.detailsJson, evidence.createdAt);
      expect(() => appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, input)).toThrow(/CAPACITY_APPEND_CORRUPT/);
    } finally {
      closeFixture(data);
    }
  });

  it("revalidates persisted session identity, token hash, workspace, and expiry before authorization", () => {
    const data = fixture();
    try {
      const beforePools = (data.db.prepare("SELECT COUNT(*) AS n FROM program_capacity_pools").get() as { n: number }).n;
      expect(() => createProgramCapacityPool(data.db, { ...data.session, tokenHash: "forged" }, data.eventId, {
        poolId: "forged", name: "Forged", unitKind: "SEAT", capacity: 1,
      })).toThrow(/SESSION_INVALID/);
      data.db.prepare("UPDATE sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(data.session.id);
      expect(() => createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "expired", name: "Expired", unitKind: "SEAT", capacity: 1,
      })).toThrow(/SESSION_INVALID/);
      expect((data.db.prepare("SELECT COUNT(*) AS n FROM program_capacity_pools").get() as { n: number }).n).toBe(beforePools);
    } finally {
      closeFixture(data);
    }
  });

  it("observes a concurrent account demotion before any mutation or denial audit", () => {
    const path = ".tmp/unit/pd01-session-race.db";
    mkdirSync(".tmp/unit", { recursive: true });
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    const first = openDb({ path });
    const workspaceId = (first.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as { id: string }).id;
    const accountId = (first.prepare("SELECT id FROM accounts WHERE workspace_id = ? AND role = 'organizer'").get(workspaceId) as { id: string }).id;
    first.prepare(`INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
      VALUES (?, ?, 'Race event', 'UTC', ?, ?, '2026-08-10T00:00:00.000Z')`).run("session-race-event", workspaceId, EVENT_TIME, "2026-09-15T10:00:00.000Z");
    first.prepare(`INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at)
      VALUES ('session-race', 'race-token', ?, ?, '2026-08-10T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`).run(accountId, workspaceId);
    const session: SessionInfo = {
      id: "session-race", tokenHash: "race-token", accountId, workspaceId, expiresAt: "2099-01-01T00:00:00.000Z",
      email: "organizer@northstar.example", displayName: "Northstar Organizer", role: "organizer",
      workspaceSlug: "northstar", workspaceName: "Northstar Network",
    };
    const second = openDb({ path, seed: false });
    try {
      second.prepare("UPDATE accounts SET role = 'read_only' WHERE id = ?").run(accountId);
      expect(() => createProgramCapacityPool(first, session, "session-race-event", {
        poolId: "race-pool", name: "Race pool", unitKind: "SEAT", capacity: 1,
      })).toThrow(/SESSION_INVALID/);
      expect((first.prepare("SELECT COUNT(*) AS n FROM program_capacity_pools").get() as { n: number }).n).toBe(0);
      expect((first.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n).toBe(0);
    } finally {
      closeDb(second);
      closeDb(first);
      for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    }
  });

  it("rejects unsafe transfer arithmetic before insertion and unsafe persisted quantities during reconstruction", () => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "large-source", name: "Large source", unitKind: "SEAT", capacity: Number.MAX_SAFE_INTEGER, effectiveFrom: EVENT_TIME });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "large-destination", name: "Large destination", unitKind: "SEAT", capacity: 0, effectiveFrom: EVENT_TIME });
      expect(() => transferProgramCapacity(data.db, data.session, data.eventId, {
        sourcePoolId: source.pool.id, destinationPoolId: destination.pool.id, unitKind: "SEAT", quantity: 1,
        reason: "overflow", approvalReference: "approval", idempotencyKey: "overflow",
      })).not.toThrow();
      // The first transfer is safe; corrupt its persisted quantity above the safe integer boundary.
      data.db.exec("DROP TRIGGER trg_capacity_transfer_decisions_immutable");
      data.db.prepare("UPDATE capacity_transfer_decisions SET quantity = ? WHERE id = (SELECT id FROM capacity_transfer_decisions LIMIT 1)").run(Number.MAX_SAFE_INTEGER + 1);
      expect(() => getProgramCapacityLedger(data.db, data.session, data.eventId)).toThrow(/CAPACITY_LEDGER_CORRUPT/);
    } finally {
      closeFixture(data);
    }
  });

  it("rejects cross-entry-point replay and fails closed when operation audit evidence is absent or duplicated", () => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "release-source", name: "Release source", unitKind: "SEAT", capacity: 2, releasePolicy: { allowRelease: true }, effectiveFrom: EVENT_TIME });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "release-destination", name: "Release destination", unitKind: "SEAT", capacity: 0, effectiveFrom: EVENT_TIME });
      const input = { sourcePoolId: source.pool.id, destinationPoolId: destination.pool.id, unitKind: "SEAT" as const, quantity: 1, reason: "release", approvalReference: "approval", idempotencyKey: "operation-key" };
      const release = releaseProgramCapacity(data.db, data.session, data.eventId, input);
      expect(release.operation).toBe("release");
      expect(() => transferProgramCapacity(data.db, data.session, data.eventId, input)).toThrow(/IDEMPOTENCY_KEY_REUSE_CONFLICT/);
      data.db.prepare("INSERT INTO audit_events (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at) VALUES ('duplicate-operation-audit', ?, 'account', ?, 'capacity.transfer.decided', 'capacity_transfer_decision', ?, '{}', ?)").run(data.workspaceId, data.session.accountId, release.decisionId, EVENT_TIME);
      expect(() => getProgramCapacityLedger(data.db, data.session, data.eventId)).toThrow(/CAPACITY_AUDIT_CORRUPT/);
    } finally {
      closeFixture(data);
    }
  });

  it.each(["null", "[]", "{\"eventId\":\"capacity-event\" , \"sequenceNumber\":1, \"fingerprint\":\"bad\", \"operation\":\"transfer\"}"])("rejects %s operation audit details as CAPACITY_AUDIT_CORRUPT", (details) => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "audit-source", name: "Audit source", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "audit-destination", name: "Audit destination", unitKind: "SEAT", capacity: 0, effectiveFrom: EVENT_TIME });
      const result = transferProgramCapacity(data.db, data.session, data.eventId, {
        sourcePoolId: source.pool.id, destinationPoolId: destination.pool.id, unitKind: "SEAT", quantity: 1,
        reason: "audit", approvalReference: "approval", idempotencyKey: `audit-${details.slice(0, 3)}`,
      });
      data.db.exec("DROP TRIGGER trg_audit_immutable");
      data.db.prepare("UPDATE audit_events SET details_json = ? WHERE target_id = ?").run(details, result.decisionId);
      expect(() => getProgramCapacityLedger(data.db, data.session, data.eventId)).toThrow(/CAPACITY_AUDIT_CORRUPT/);
    } finally {
      closeFixture(data);
    }
  });

  it("requires exact canonical decision detail equality, including every immutable field", () => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "exact-source", name: "Exact source", unitKind: "SEAT", capacity: 2, effectiveFrom: EVENT_TIME });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "exact-destination", name: "Exact destination", unitKind: "SEAT", capacity: 0, effectiveFrom: EVENT_TIME });
      const result = transferProgramCapacity(data.db, data.session, data.eventId, {
        sourcePoolId: source.pool.id, destinationPoolId: destination.pool.id, unitKind: "SEAT", quantity: 1,
        reason: "exact", approvalReference: "approval", idempotencyKey: "exact-details",
      });
      const audit = data.db.prepare("SELECT details_json AS detailsJson FROM audit_events WHERE target_id = ?").get(result.decisionId) as { detailsJson: string };
      const details = JSON.parse(audit.detailsJson) as Record<string, unknown>;
      details.quantity = 99;
      details.extra = true;
      data.db.exec("DROP TRIGGER trg_audit_immutable");
      data.db.prepare("UPDATE audit_events SET details_json = ? WHERE target_id = ?").run(canonicalJson(details), result.decisionId);
      expect(() => getProgramCapacityLedger(data.db, data.session, data.eventId)).toThrow(/CAPACITY_AUDIT_CORRUPT/);
    } finally {
      closeFixture(data);
    }
  });

  it("rejects a persisted maximum version before safe version progression", () => {
    const data = fixture();
    try {
      const pool = createProgramCapacityPool(data.db, data.session, data.eventId, { poolId: "max-version", name: "Max version", unitKind: "SEAT", capacity: 1, effectiveFrom: EVENT_TIME });
      data.db.exec("DROP TRIGGER trg_program_capacity_pool_versions_immutable");
      const row = data.db.prepare(`SELECT workspace_id AS workspaceId, event_id AS eventId, pool_id AS poolId, unit_kind AS unitKind,
        capacity, scope_json AS scopeJson, eligibility_json AS eligibilityJson, reserved_for_json AS reservedForJson,
        release_policy_json AS releasePolicyJson, effective_from AS effectiveFrom, effective_to AS effectiveTo,
        created_at AS createdAt FROM program_capacity_pool_versions WHERE id = ?`).get(pool.version.id) as Record<string, unknown>;
      const fingerprint = fingerprintOf({ schema: "pd01-capacity-pool-version/v1", workspaceId: row.workspaceId, eventId: row.eventId,
        poolId: row.poolId, versionNumber: Number.MAX_SAFE_INTEGER, unitKind: row.unitKind, capacity: row.capacity,
        scope: JSON.parse(row.scopeJson as string), eligibility: JSON.parse(row.eligibilityJson as string),
        reservedFor: JSON.parse(row.reservedForJson as string), releasePolicy: JSON.parse(row.releasePolicyJson as string),
        effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, createdAt: row.createdAt });
      data.db.prepare("UPDATE program_capacity_pool_versions SET version_number = ?, fingerprint = ? WHERE id = ?").run(Number.MAX_SAFE_INTEGER, fingerprint, pool.version.id);
      expect(() => appendProgramCapacityPoolVersion(data.db, data.session, data.eventId, {
        poolId: pool.pool.id, idempotencyKey: "max-version-append", capacity: 1, effectiveFrom: EVENT_TIME,
      })).toThrow(/CAPACITY_VERSION_CORRUPT/);
    } finally {
      closeFixture(data);
    }
  });

  it("captures public values once and converts null/getter/proxy failures to stable input errors", () => {
    const data = fixture();
    try {
      let poolReads = 0;
      const input = {
        get poolId() { poolReads += 1; return "captured"; },
        name: "Captured", unitKind: "SEAT", capacity: 1, effectiveFrom: EVENT_TIME,
      } as unknown as Parameters<typeof createProgramCapacityPool>[3];
      expect(createProgramCapacityPool(data.db, data.session, data.eventId, input).pool.id).toBe("captured");
      expect(poolReads).toBe(1);

      const throwingInput = new Proxy({}, { get() { throw new Error("secret getter"); } });
      expect(() => createProgramCapacityPool(data.db, data.session, data.eventId, throwingInput as never)).toThrow(/CAPACITY_INPUT_INVALID/);
      expect(() => createProgramCapacityPool(data.db, data.session, data.eventId, null as never)).toThrow(/CAPACITY_INPUT_INVALID/);
      const throwingSession = new Proxy(data.session, { get(_target, key) { if (key === "role") throw new Error("secret session getter"); return Reflect.get(data.session, key); } });
      expect(() => getProgramCapacityLedger(data.db, throwingSession as SessionInfo, data.eventId)).toThrow(/CAPACITY_INPUT_INVALID/);
    } finally {
      closeFixture(data);
    }
  });

  it("rejects persisted receipt corruption and deeply freezes all returned output", () => {
    const data = fixture();
    try {
      const source = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "source", name: "Source", unitKind: "SEAT", capacity: 5, scope: { nested: [{ value: 1 }] }, effectiveFrom: EVENT_TIME,
      });
      const destination = createProgramCapacityPool(data.db, data.session, data.eventId, {
        poolId: "destination", name: "Destination", unitKind: "SEAT", capacity: 1, effectiveFrom: EVENT_TIME,
      });
      const transfer = transferProgramCapacity(data.db, data.session, data.eventId, {
        sourcePoolId: source.pool.id, destinationPoolId: destination.pool.id, unitKind: "SEAT", quantity: 1,
        reason: "approved", approvalReference: "approval", idempotencyKey: "freeze-check",
      });
      expect(Object.isFrozen(transfer)).toBe(true);
      expect(Object.isFrozen(transfer.receipt)).toBe(true);
      expect(Object.isFrozen(transfer.ledger)).toBe(true);
      expect(Object.isFrozen(transfer.ledger.pools)).toBe(true);
      expect(Object.isFrozen(source.pool)).toBe(true);
      expect(Object.isFrozen(source.version)).toBe(true);
      expect(Object.isFrozen(source.version.scope)).toBe(true);
      expect(Object.isFrozen((source.version.scope as { nested: unknown[] }).nested)).toBe(true);
      expect(() => (transfer.ledger.pools as unknown as Array<unknown>).push({})).toThrow();

      data.db.exec("DROP TRIGGER trg_capacity_transfer_receipts_immutable");
      data.db.prepare("UPDATE capacity_transfer_receipts SET quantity = 99 WHERE decision_id = ?").run(transfer.decisionId);
      expect(() => getProgramCapacityLedger(data.db, data.session, data.eventId)).toThrow(/CAPACITY_RECEIPT_CORRUPT/);
    } finally {
      closeFixture(data);
    }
  });
});
