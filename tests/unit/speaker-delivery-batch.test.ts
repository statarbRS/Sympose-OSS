import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@/server/db";
import {
  SPEAKER_COMMUNICATION_TEMPLATE_KEY,
  listSpeakerCommunicationDeliveryLog,
  queueSpeakerCommunicationBatch,
  type SpeakerCommunicationDeliveryLogEntry,
} from "@/server/services/speaker-communications";
import {
  createManualSpeaker,
  listManualSpeakerRecords as listManualSpeakerRecordsBatched,
  ManualSpeakerError,
} from "@/server/services/speaker-operations";
import type { SpeakerOrganizerScope } from "@/server/services/speaker-operations/contracts";

const AT = "2026-08-14T00:00:00.000Z";
const WORKSPACE_A = "speaker-batch-workspace-a";
const WORKSPACE_B = "speaker-batch-workspace-b";
const ACCOUNT_A = "speaker-batch-account-a";
const ACCOUNT_B = "speaker-batch-account-b";
const EVENT_A = "speaker-batch-event-a";
const EVENT_A2 = "speaker-batch-event-a2";
const EVENT_B = "speaker-batch-event-b";
const SPEAKER_COUNT = 180;
const MESSAGE_COUNT = 2_300;
const WARMUPS = 2;
const REPETITIONS = 10;
const EXACT_BASELINE = {
  // Recorded on the exact base SHA with the same 180-speaker/2,300-message fixture.
  median: 7_196.863,
  p95: 8_277.65,
} as const;

const scopeA = { kind: "organizer" as const, workspaceId: WORKSPACE_A, eventId: EVENT_A, actorId: ACCOUNT_A };
const scopeA2 = { ...scopeA, eventId: EVENT_A2 };
const scopeB = { kind: "organizer" as const, workspaceId: WORKSPACE_B, eventId: EVENT_B, actorId: ACCOUNT_B };

const databases: Db[] = [];

function setup(): Db {
  const db = openDb({ path: ":memory:", seed: false });
  databases.push(db);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(WORKSPACE_A, "speaker-batch-a", "Speaker Batch A", AT);
  db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(WORKSPACE_B, "speaker-batch-b", "Speaker Batch B", AT);
  db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, 'organizer', ?)")
    .run(ACCOUNT_A, WORKSPACE_A, "organizer-a@example.test", "Organizer A", AT);
  db.prepare("INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, 'organizer', ?)")
    .run(ACCOUNT_B, WORKSPACE_B, "organizer-b@example.test", "Organizer B", AT);
  const insertEvent = db.prepare(
    "INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at) VALUES (?, ?, ?, 'UTC', ?, ?, ?)",
  );
  insertEvent.run(EVENT_A, WORKSPACE_A, "Speaker Batch Event A", "2026-09-01T09:00:00.000Z", "2026-09-01T17:00:00.000Z", AT);
  insertEvent.run(EVENT_A2, WORKSPACE_A, "Speaker Batch Event A2", "2026-10-01T09:00:00.000Z", "2026-10-01T17:00:00.000Z", AT);
  insertEvent.run(EVENT_B, WORKSPACE_B, "Speaker Batch Event B", "2026-09-01T09:00:00.000Z", "2026-09-01T17:00:00.000Z", AT);
  return db;
}

function countedDb(db: Db) {
  let prepareCount = 0;
  const sqlCounts = new Map<string, number>();
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          prepareCount += 1;
          const normalized = sql.replace(/\s+/gu, " ").trim();
          sqlCounts.set(normalized, (sqlCounts.get(normalized) ?? 0) + 1);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
  return {
    db: proxy,
    reset() {
      prepareCount = 0;
      sqlCounts.clear();
    },
    snapshot() {
      return {
        prepareCount,
        topSql: [...sqlCounts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, 5)
          .map(([sql, count]) => ({ count, sql })),
      };
    },
  };
}

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sampleVariance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    samples: values.length,
    median: Number(percentile(0.5).toFixed(3)),
    p95: Number(percentile(0.95).toFixed(3)),
    mean: Number(mean.toFixed(3)),
    sampleVariance: Number(sampleVariance.toFixed(3)),
    min: Number(sorted[0]!.toFixed(3)),
    max: Number(sorted.at(-1)!.toFixed(3)),
  };
}

function createSpeaker(
  db: Db,
  scope: SpeakerOrganizerScope,
  alias: string,
  fullName: string,
  email: string,
) {
  return createManualSpeaker(db, scope, {
    fullName,
    email,
    title: `${alias} title`,
    organization: `${alias} organization`,
    bio: `${alias} bio`,
    idempotencyKey: `${alias}-${scope.eventId}-create`,
  }).record;
}

function queueMessages(
  db: Db,
  workspaceId: string,
  eventId: string,
  idempotencyKey: string,
  recipients: readonly { readonly personId: string; readonly email: string; readonly displayName: string }[],
) {
  return queueSpeakerCommunicationBatch(db, {
    workspaceId,
    eventId,
    idempotencyKey,
    templateKey: SPEAKER_COMMUNICATION_TEMPLATE_KEY,
    subjectTemplate: "Speaker update for {{displayName}}",
    bodyTemplate: "Hello {{displayName}}",
    recipients,
  });
}

function rewriteRecipientPersonId(db: Db, messageId: string, personId: string | null, omit = false): void {
  const row = db.prepare("SELECT payload_json FROM outbox_messages WHERE id = ?").get(messageId) as { payload_json: string };
  const payload = JSON.parse(row.payload_json) as { recipient: Record<string, unknown> };
  if (omit) {
    delete payload.recipient.personId;
  } else {
    payload.recipient.personId = personId;
  }
  db.prepare("UPDATE outbox_messages SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), messageId);
}

function captureError(operation: () => unknown): { readonly name: string; readonly code: unknown; readonly message: string } {
  try {
    operation();
  } catch (error) {
    return {
      name: error instanceof Error ? error.name : typeof error,
      code: error instanceof ManualSpeakerError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  throw new Error("Expected operation to fail.");
}

/** Model the prior per-speaker delivery projection without retaining its production N+1 loop. */
function priorDeliveryEvidenceForPerson(db: Db, scope: SpeakerOrganizerScope, personId: string) {
  let rows: readonly SpeakerCommunicationDeliveryLogEntry[];
  try {
    rows = listSpeakerCommunicationDeliveryLog(db, scope).filter((entry) => entry.personId === personId);
  } catch {
    throw new ManualSpeakerError("STATE_INVALID", "Stored speaker delivery evidence is unavailable.");
  }
  for (const row of rows) {
    if (row.workspaceId !== scope.workspaceId || row.eventId !== scope.eventId || row.personId !== personId || !["PENDING", "CLAIMED", "DELIVERED", "FAILED"].includes(row.status)) {
      throw new ManualSpeakerError("STATE_INVALID", "Stored speaker delivery evidence is outside the authorized scope.");
    }
  }
  if (rows.length === 0) {
    return {
      source: "no-durable-evidence" as const,
      state: "NO_DURABLE_EVIDENCE" as const,
      messageIds: Object.freeze([]),
      latestAt: null,
    };
  }
  const latest = rows.at(-1)!;
  return {
    source: "durable-outbox" as const,
    state: latest.status,
    messageIds: Object.freeze(rows.map((row) => row.messageId)),
    latestAt: latest.deliveredAt ?? latest.createdAt,
  };
}

function priorSemantics(
  db: Db,
  scope: SpeakerOrganizerScope,
  records: ReturnType<typeof listManualSpeakerRecordsBatched>,
) {
  return Object.freeze(records.map((record) => Object.freeze({
    ...record,
    deliveryEvidence: priorDeliveryEvidenceForPerson(db, scope, record.personId),
  })));
}

function seedPerformanceWorkload(db: Db): { readonly people: readonly { readonly id: string; readonly email: string; readonly name: string }[] } {
  const insertPerson = db.prepare(
    "INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertSpeaker = db.prepare(
    "INSERT INTO event_speakers (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'SPEAKER', 'PENDING', ?, ?)",
  );
  const people = Array.from({ length: SPEAKER_COUNT }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    const person = {
      id: `performance-speaker-${suffix}`,
      email: `performance-speaker-${suffix}@example.test`,
      name: `Performance Speaker ${suffix}`,
    };
    insertPerson.run(person.id, WORKSPACE_A, person.email, person.name, "Synthetic Organization", "Synthetic Speaker", AT);
    insertSpeaker.run(`performance-event-speaker-${suffix}`, WORKSPACE_A, EVENT_A, person.id, AT, AT);
    return person;
  });

  for (let batchIndex = 0; batchIndex < MESSAGE_COUNT / 100; batchIndex += 1) {
    const recipients = Array.from({ length: 100 }, (_, offset) => people[(batchIndex * 37 + offset) % people.length]!)
      .map((person) => ({ personId: person.id, email: person.email, displayName: person.name }));
    queueMessages(db, WORKSPACE_A, EVENT_A, `performance-speaker-batch-${String(batchIndex + 1).padStart(2, "0")}`, recipients);
  }
  return { people };
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
});

describe("batched manual-speaker durable delivery projection", () => {
  it("keeps representative output, scope, ordering, duplicates, and malformed-row behavior equivalent", () => {
    const db = setup();
    const noMessage = createSpeaker(db, scopeA, "no-message", "No Message Speaker", "no-message@example.test");
    const multiple = createSpeaker(db, scopeA, "multiple", "Multiple Message Speaker", "multiple@example.test");
    const normalized = createSpeaker(db, scopeA, "normalized", "Normalized Identity Speaker", " NORMALIZED@EXAMPLE.TEST ");

    const firstTargetBatch = queueMessages(db, WORKSPACE_A, EVENT_A, "representative-target-1", [
      { personId: multiple.personId, email: multiple.email, displayName: multiple.fullName },
      { personId: normalized.personId, email: normalized.email, displayName: normalized.fullName },
    ]);
    const secondTargetBatch = queueMessages(db, WORKSPACE_A, EVENT_A, "representative-target-2", [
      { personId: multiple.personId, email: multiple.email, displayName: multiple.fullName },
    ]);

    const updateStatus = db.prepare("UPDATE outbox_messages SET status = ?, delivered_at = ? WHERE id = ?");
    updateStatus.run("DELIVERED", "2026-08-14T00:00:01.000Z", firstTargetBatch.messageIds[0]);
    updateStatus.run("FAILED", null, firstTargetBatch.messageIds[1]);
    updateStatus.run("PENDING", null, secondTargetBatch.messageIds[0]);

    const crossEventPerson = createSpeaker(db, scopeA2, "cross-event", multiple.fullName, multiple.email);
    const crossEventDelivery = queueMessages(db, WORKSPACE_A, EVENT_A2, "representative-cross-event", [
      { personId: crossEventPerson.personId, email: crossEventPerson.email, displayName: crossEventPerson.fullName },
    ]);
    const crossWorkspacePerson = createSpeaker(db, scopeB, "cross-workspace", "Cross Workspace Decoy", " MULTIPLE@EXAMPLE.TEST ");
    const crossWorkspaceDelivery = queueMessages(db, WORKSPACE_B, EVENT_B, "representative-cross-workspace", [
      { personId: crossWorkspacePerson.personId, email: crossWorkspacePerson.email, displayName: crossWorkspacePerson.fullName },
    ]);

    expect(crossEventPerson.personId).toBe(multiple.personId);
    expect(crossWorkspacePerson.email).toBe(multiple.email);
    db.exec("DROP TRIGGER IF EXISTS trg_v12_outbox_workspace_update_guard");
    const equalCreatedAt = "2026-08-14T00:00:02.000Z";
    db.prepare("UPDATE outbox_messages SET created_at = ? WHERE id = ?").run(equalCreatedAt, firstTargetBatch.messageIds[0]);
    db.prepare("UPDATE outbox_messages SET created_at = ? WHERE id = ?").run(equalCreatedAt, secondTargetBatch.messageIds[0]);

    const expected = priorSemantics(db, scopeA, listManualSpeakerRecordsBatched(db, scopeA));
    const counter = countedDb(db);
    counter.reset();
    const actual = listManualSpeakerRecordsBatched(counter.db, scopeA);
    const instrumentation = counter.snapshot();

    expect(actual).toEqual(expected);
    expect(instrumentation.prepareCount).toBe(4);
    expect(actual).toHaveLength(3);
    expect(actual.find((record) => record.personId === noMessage.personId)?.deliveryEvidence).toEqual({
      source: "no-durable-evidence",
      state: "NO_DURABLE_EVIDENCE",
      messageIds: [],
      latestAt: null,
    });
    expect(actual.find((record) => record.personId === multiple.personId)?.deliveryEvidence).toMatchObject({
      source: "durable-outbox",
      state: "PENDING",
      messageIds: [firstTargetBatch.messageIds[0], secondTargetBatch.messageIds[0]],
    });
    expect(actual.find((record) => record.personId === normalized.personId)?.email).toBe("normalized@example.test");
    expect(actual.every((record) => record.workspaceId === WORKSPACE_A && record.eventId === EVENT_A)).toBe(true);
    const projectedMessageIds = actual.flatMap((record) => record.deliveryEvidence.messageIds);
    expect(projectedMessageIds).not.toContain(crossEventDelivery.messageIds[0]);
    expect(projectedMessageIds).not.toContain(crossWorkspaceDelivery.messageIds[0]);

    db.prepare("UPDATE outbox_messages SET payload_json = ? WHERE id = ?").run("{", firstTargetBatch.messageIds[0]);
    const oldError = captureError(() => priorDeliveryEvidenceForPerson(db, scopeA, multiple.personId));
    const newError = captureError(() => listManualSpeakerRecordsBatched(db, scopeA));
    expect(newError).toEqual(oldError);
    expect(newError).toEqual({
      name: "ManualSpeakerError",
      code: "STATE_INVALID",
      message: "Stored speaker delivery evidence is unavailable.",
    });

    const equivalenceDigest = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
    process.stdout.write(`SPEAKER_BATCH_EQUIVALENCE:${JSON.stringify({ equivalenceDigest, preparedStatements: instrumentation.prepareCount })}\n`);
  });

  it("matches per-speaker filtering for absent or unknown recipients while retaining relevant fail-closed validation", () => {
    const db = setup();
    const noMessage = createSpeaker(db, scopeA, "no-message", "No Message Speaker", "no-message@example.test");
    const target = createSpeaker(db, scopeA, "target", "Target Speaker", "target@example.test");
    const other = createSpeaker(db, scopeA, "other", "Other Speaker", "other@example.test");
    const relevantBatch = queueMessages(db, WORKSPACE_A, EVENT_A, "differential-relevant", [
      { personId: target.personId, email: target.email, displayName: target.fullName },
    ]);
    const nullPersonBatch = queueMessages(db, WORKSPACE_A, EVENT_A, "differential-null-person", [
      { personId: noMessage.personId, email: noMessage.email, displayName: noMessage.fullName },
    ]);
    const missingPersonBatch = queueMessages(db, WORKSPACE_A, EVENT_A, "differential-missing-person", [
      { personId: target.personId, email: target.email, displayName: target.fullName },
    ]);
    const unknownPersonBatch = queueMessages(db, WORKSPACE_A, EVENT_A, "differential-unknown-person", [
      { personId: other.personId, email: other.email, displayName: other.fullName },
    ]);

    const baseline = listManualSpeakerRecordsBatched(db, scopeA);
    db.exec("DROP TRIGGER IF EXISTS trg_v12_outbox_workspace_update_guard");
    rewriteRecipientPersonId(db, nullPersonBatch.messageIds[0], null);
    rewriteRecipientPersonId(db, missingPersonBatch.messageIds[0], null, true);
    rewriteRecipientPersonId(db, unknownPersonBatch.messageIds[0], "speaker-batch-not-on-roster");

    const expected = priorSemantics(db, scopeA, baseline);
    const counter = countedDb(db);
    counter.reset();
    const actual = listManualSpeakerRecordsBatched(counter.db, scopeA);
    expect(actual).toEqual(expected);
    expect(counter.snapshot().prepareCount).toBe(4);
    expect(actual.find((record) => record.personId === noMessage.personId)?.deliveryEvidence.state).toBe("NO_DURABLE_EVIDENCE");
    expect(actual.find((record) => record.personId === target.personId)?.deliveryEvidence.messageIds).toEqual([relevantBatch.messageIds[0]]);
    expect(actual.find((record) => record.personId === other.personId)?.deliveryEvidence.state).toBe("NO_DURABLE_EVIDENCE");

    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE outbox_messages SET status = 'CORRUPTED' WHERE id = ?").run(unknownPersonBatch.messageIds[0]);
    const expectedWithIgnoredInvalid = priorSemantics(db, scopeA, baseline);
    expect(listManualSpeakerRecordsBatched(db, scopeA)).toEqual(expectedWithIgnoredInvalid);

    db.prepare("UPDATE outbox_messages SET status = 'PENDING' WHERE id = ?").run(unknownPersonBatch.messageIds[0]);
    db.prepare("UPDATE outbox_messages SET status = 'CORRUPTED' WHERE id = ?").run(relevantBatch.messageIds[0]);
    const oldError = captureError(() => priorDeliveryEvidenceForPerson(db, scopeA, target.personId));
    const newError = captureError(() => listManualSpeakerRecordsBatched(db, scopeA));
    expect(newError).toEqual(oldError);
    expect(newError).toEqual({
      name: "ManualSpeakerError",
      code: "STATE_INVALID",
      message: "Stored speaker delivery evidence is outside the authorized scope.",
    });
  });

  it("reproduces the 180-speaker/2,300-message workload with bounded statements and measured improvement", { timeout: 300_000 }, () => {
    const db = setup();
    seedPerformanceWorkload(db);
    const newCounter = countedDb(db);
    const scope = scopeA;
    const measureNew = () => {
      newCounter.reset();
      const started = performance.now();
      const records = listManualSpeakerRecordsBatched(newCounter.db, scope);
      return { elapsed: performance.now() - started, records, instrumentation: newCounter.snapshot() };
    };

    for (let index = 0; index < WARMUPS; index += 1) {
      measureNew();
    }

    const newElapsed: number[] = [];
    let newRecords = measureNew().records;
    let newInstrumentation = newCounter.snapshot();
    newElapsed.push(measureNew().elapsed);
    for (let index = 1; index < REPETITIONS; index += 1) {
      const newResult = measureNew();
      newElapsed.push(newResult.elapsed);
      newRecords = newResult.records;
      newInstrumentation = newResult.instrumentation;
    }

    const after = summarize(newElapsed);
    const medianImprovement = 1 - after.median / EXACT_BASELINE.median;
    const p95Improvement = 1 - after.p95 / EXACT_BASELINE.p95;
    expect(newRecords).toHaveLength(SPEAKER_COUNT);
    expect(newRecords).toEqual(priorSemantics(db, scope, newRecords));
    expect(newInstrumentation.prepareCount).toBe(4);
    expect(medianImprovement).toBeGreaterThanOrEqual(0.8);
    expect(p95Improvement).toBeGreaterThanOrEqual(0.8);

    process.stdout.write(`PERF_SPEAKER_BATCH_RESULT:${JSON.stringify({
      schema: "sympose-performance-speaker-batch/v1",
      workload: { speakers: SPEAKER_COUNT, outboxMessages: MESSAGE_COUNT },
      warmups: WARMUPS,
      repetitions: REPETITIONS,
      before: EXACT_BASELINE,
      after,
      improvement: { median: Number(medianImprovement.toFixed(6)), p95: Number(p95Improvement.toFixed(6)) },
      preparedStatements: { before: SPEAKER_COUNT + 3, after: newInstrumentation.prepareCount },
      equivalenceDigest: createHash("sha256").update(JSON.stringify(newRecords)).digest("hex"),
    })}\n`);
  });
});
