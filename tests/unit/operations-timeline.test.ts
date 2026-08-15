import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  getOperationsTimeline,
  OPERATIONS_TIMELINE_LIMIT,
  OperationsTimeline,
} from "@/components/operations-timeline/operations-timeline";
import { fingerprintOf } from "@/server/canonical";
import { closeDb, openDb, type Db } from "@/server/db";

interface WorkspaceFixture {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly personId: string;
}

function workspaceFixture(db: Db, slug: string): WorkspaceFixture {
  const workspace = db.prepare(
    `SELECT workspace.id AS workspaceId, account.id AS accountId
     FROM workspaces workspace
     JOIN accounts account ON account.workspace_id = workspace.id
     WHERE workspace.slug = ?
     ORDER BY account.id
     LIMIT 1`,
  ).get(slug) as Omit<WorkspaceFixture, "personId"> | undefined;
  if (!workspace) throw new Error(`Missing seeded workspace fixture: ${slug}`);
  const personId = `operations-timeline-person-${slug}`;
  db.prepare(
    `INSERT OR IGNORE INTO people
       (id, workspace_id, canonical_email, full_name, organization, title, created_at)
     VALUES (?, ?, ?, 'Synthetic Timeline Person', 'Synthetic Test', 'Tester',
             '2026-08-12T00:00:00.000Z')`,
  ).run(personId, workspace.workspaceId, `timeline-${slug}@synthetic.invalid`);
  return { ...workspace, personId };
}

function insertTimelineEvidence(
  db: Db,
  fixture: WorkspaceFixture,
  eventId: string,
  prefix: string,
  baseHour: number,
): void {
  const at = (hourOffset: number) => `2026-08-12T${String(baseHour + hourOffset).padStart(2, "0")}:00:00.000Z`;
  const unitId = `${prefix}-unit`;
  const roomId = `${prefix}-room`;
  const runId = `${prefix}-run`;
  const planId = `${prefix}-plan`;
  const offerId = `${prefix}-offer`;

  db.prepare(
    `INSERT INTO events
       (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, 'UTC', '2026-09-15T09:00:00.000Z', '2026-09-15T17:00:00.000Z', 'planning', ?)`,
  ).run(eventId, fixture.workspaceId, `${prefix} event`, at(0));
  db.prepare(
    `INSERT INTO program_units
       (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
     VALUES (?, ?, ?, ?, 'session', '2026-09-15T10:00:00.000Z', '2026-09-15T11:00:00.000Z', 40, ?)`,
  ).run(unitId, fixture.workspaceId, eventId, `${prefix} session`, at(0));
  db.prepare(
    `INSERT INTO event_rooms (id, workspace_id, event_id, name, capacity, created_at)
     VALUES (?, ?, ?, ?, 80, ?)`,
  ).run(roomId, fixture.workspaceId, eventId, `${prefix} room`, at(0));
  db.prepare(
    `INSERT INTO event_session_allocations
       (id, workspace_id, event_id, program_unit_id, room_id, track_id,
        starts_at, ends_at, allocation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL,
             '2026-09-15T10:00:00.000Z', '2026-09-15T11:00:00.000Z', 'PUBLISHED', ?, ?)`,
  ).run(`${prefix}-allocation`, fixture.workspaceId, eventId, unitId, roomId, at(1), at(1));
  db.prepare(
    `INSERT INTO plan_runs
       (id, workspace_id, event_id, status, input_fingerprint, input_manifest_json,
        compiler, compiler_version, created_at)
     VALUES (?, ?, ?, 'FEASIBLE', ?, '{}', 'timeline-test', '1', ?)`,
  ).run(runId, fixture.workspaceId, eventId, `${prefix}-input`, at(0));
  db.prepare(
    `INSERT INTO plan_versions
       (id, workspace_id, event_id, run_id, version_number, fingerprint, content_json, created_at)
     VALUES (?, ?, ?, ?, 1, ?, '{}', ?)`,
  ).run(planId, fixture.workspaceId, eventId, runId, `${prefix}-plan-fingerprint`, at(0));
  db.prepare(
    `INSERT INTO approvals
       (id, workspace_id, event_id, plan_version_id, actor_account_id, decision, created_at)
     VALUES (?, ?, ?, ?, ?, 'approved', ?)`,
  ).run(`${prefix}-approval`, fixture.workspaceId, eventId, planId, fixture.accountId, at(2));
  db.prepare(
    `INSERT INTO commitment_offers
       (id, workspace_id, event_id, plan_version_id, person_id, terms_json,
        terms_fingerprint, status, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, 'offered', ?)`,
  ).run(offerId, fixture.workspaceId, eventId, planId, fixture.personId, `${prefix}-terms`, at(1));
  db.prepare(
    `INSERT INTO commitment_responses
       (id, workspace_id, offer_id, response, responded_at, actor_person_id)
     VALUES (?, ?, ?, 'accepted', ?, ?)`,
  ).run(`${prefix}-response`, fixture.workspaceId, offerId, at(3), fixture.personId);
  db.prepare(
    `INSERT INTO publication_releases
       (id, workspace_id, event_id, plan_version_id, audience_policy_version,
        commitment_watermark, fingerprint, content_json, sealed_at)
     VALUES (?, ?, ?, ?, 1, 1, ?, '{}', ?)`,
  ).run(`${prefix}-release`, fixture.workspaceId, eventId, planId, `${prefix}-release-fingerprint`, at(4));
  const observation = db.prepare(
    `INSERT INTO observations
       (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
        observed_at, source, idempotency_key, recorded_at)
     VALUES (?, ?, ?, ?, ?, 'attendance', ?, 'synthetic-unit-test', ?, ?)`,
  );
  observation.run(`${prefix}-observation-b`, fixture.workspaceId, eventId, fixture.personId, unitId, at(5), `${prefix}-observation-key-b`, at(6));
  observation.run(`${prefix}-observation-a`, fixture.workspaceId, eventId, fixture.personId, unitId, at(5), `${prefix}-observation-key-a`, at(6));
}

describe("event operations activity timeline", () => {
  it("fails closed across workspace and event boundaries", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspaceFixture(db, "northstar");
      const acme = workspaceFixture(db, "acme");
      insertTimelineEvidence(db, northstar, "target-event", "target", 7);
      insertTimelineEvidence(db, northstar, "sibling-event", "sibling", 7);
      insertTimelineEvidence(db, acme, "foreign-event", "foreign", 7);

      const target = getOperationsTimeline(db, northstar.workspaceId, "target-event");
      expect(target.entries).toHaveLength(6);
      expect(target.entries.every((entry) => entry.sourceId.startsWith("target-"))).toBe(true);
      expect(target.entries.map((entry) => entry.sourceId).join(" ")).not.toMatch(/sibling|foreign/u);

      expect(getOperationsTimeline(db, acme.workspaceId, "target-event").entries).toEqual([]);
      expect(getOperationsTimeline(db, northstar.workspaceId, "missing-event").entries).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  it("sorts by persisted occurrence time with stable stage and record tie-breakers", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspaceFixture(db, "northstar");
      insertTimelineEvidence(db, northstar, "chronology-event", "chronology", 7);

      const projection = getOperationsTimeline(db, northstar.workspaceId, "chronology-event");
      expect(projection.entries.map((entry) => [entry.stage, entry.sourceId])).toEqual([
        ["schedule", "chronology-allocation"],
        ["approval", "chronology-approval"],
        ["commitment", "chronology-response"],
        ["publication", "chronology-release"],
        ["operational", "chronology-observation-a"],
        ["operational", "chronology-observation-b"],
      ]);
      expect(projection.entries.map((entry) => entry.occurredAt)).toEqual(
        [...projection.entries.map((entry) => entry.occurredAt)].sort(),
      );
      expect(projection.entries.find((entry) => entry.sourceId === "chronology-observation-a")?.detail)
        .toContain("occurred at 2026-08-12T12:00:00.000Z · ingested at 2026-08-12T13:00:00.000Z");
    } finally {
      closeDb(db);
    }
  });

  it("renders provenance and truthful missing-stage states without mutation controls", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspaceFixture(db, "northstar");
      insertTimelineEvidence(db, northstar, "render-event", "render", 7);
      const projection = getOperationsTimeline(db, northstar.workspaceId, "render-event");
      const html = renderToStaticMarkup(createElement(OperationsTimeline, {
        projection,
        timezone: "UTC",
      }));

      expect(html).toContain("record-backed activities");
      expect(html).toContain("Decision truth");
      expect(html).toContain("Commitment truth");
      expect(html).toContain("Operational truth");
      expect(html).toContain("Published projection");
      expect(html).toContain("event_session_allocations");
      expect(html).toContain("commitment_responses · commitment_offers");
      expect(html).toContain("No submitted proposal record exists for this event.");
      expect(html).toContain("No persisted speaker artifact record exists for this event.");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("idempotency");
    } finally {
      closeDb(db);
    }
  });

  it("renders explicit original-to-correction lineage with a bounded reason preview", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspaceFixture(db, "northstar");
      const eventId = "lineage-event";
      const unitId = "lineage-unit";
      const originalId = "lineage-original-observation";
      const correctionId = "lineage-correction-observation";
      const relationId = "lineage-correction-relation";
      const observedAt = "2026-08-12T12:00:00.000Z";
      const correctedAt = "2026-08-12T12:01:00.000Z";
      const reason = "🙂".repeat(280);
      db.prepare(
        `INSERT INTO events
           (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
         VALUES (?, ?, 'Lineage event', 'UTC', '2026-08-12T11:00:00.000Z',
                 '2026-08-12T13:00:00.000Z', 'live', '2026-08-12T07:00:00.000Z')`,
      ).run(eventId, northstar.workspaceId);
      db.prepare(
        `INSERT INTO program_units
           (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
         VALUES (?, ?, ?, 'Lineage session', 'session', '2026-08-12T11:30:00.000Z',
                 '2026-08-12T12:30:00.000Z', 40, '2026-08-12T07:00:00.000Z')`,
      ).run(unitId, northstar.workspaceId, eventId);
      const originalKey = `attendance-observation:v1:${fingerprintOf({
        schema: "attendance-observation-key/v1",
        workspaceId: northstar.workspaceId,
        eventId,
        personId: northstar.personId,
        programUnitId: unitId,
        observedMeaning: "ATTENDED",
      })}`;
      const correctionKey = `attendance-correction:v1:${fingerprintOf({
        schema: "attendance-correction-key/v1",
        workspaceId: northstar.workspaceId,
        originalObservationId: originalId,
        correctedMeaning: "DID_NOT_ATTEND",
      })}`;
      const commandFingerprint = fingerprintOf({
        schema: "attendance-correction-command/v1",
        workspaceId: northstar.workspaceId,
        originalObservationId: originalId,
        correctedMeaning: "DID_NOT_ATTEND",
        reason,
      });
      db.prepare(
        `INSERT INTO observations
           (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
            observed_at, source, idempotency_key, recorded_at)
         VALUES (?, ?, ?, ?, ?, 'attendance', ?, 'organizer-live-operations', ?, ?)`,
      ).run(
        originalId,
        northstar.workspaceId,
        eventId,
        northstar.personId,
        unitId,
        observedAt,
        originalKey,
        "2026-08-12T12:00:30.000Z",
      );
      db.prepare(
        `INSERT INTO observations
           (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
            observed_at, source, idempotency_key, recorded_at)
         VALUES (?, ?, ?, ?, ?, 'attendance_not_attended', ?,
                 'organizer-live-operations-correction', ?, ?)`,
      ).run(
        correctionId,
        northstar.workspaceId,
        eventId,
        northstar.personId,
        unitId,
        correctedAt,
        correctionKey,
        correctedAt,
      );
      db.prepare(
        `INSERT INTO observation_corrections
           (id, workspace_id, original_observation_id, correction_observation_id, reason,
            actor_account_id, actor_role, corrected_at, idempotency_key, command_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, 'organizer', ?, ?, ?)`,
      ).run(
        relationId,
        northstar.workspaceId,
        originalId,
        correctionId,
        reason,
        northstar.accountId,
        correctedAt,
        correctionKey,
        commandFingerprint,
      );

      const projection = getOperationsTimeline(db, northstar.workspaceId, eventId);
      expect(projection.entries).toHaveLength(2);
      expect(projection.entries).toEqual([
        expect.objectContaining({
          sourceId: originalId,
          title: "Attendance originally observed — superseded",
          source: "observations · observation_corrections",
          fingerprint: commandFingerprint,
        }),
        expect.objectContaining({
          sourceId: correctionId,
          title: "Attendance corrected: did not attend",
          source: "observations · observation_corrections",
          fingerprint: commandFingerprint,
        }),
      ]);
      expect(projection.entries[0]?.detail).toContain("superseded");
      expect(projection.entries[1]?.detail).toContain("recorded by organizer");
      expect(projection.entries[1]?.detail).toContain("current");
      expect(projection.entries.every((entry) => entry.detail.length <= 640)).toBe(true);
      const html = renderToStaticMarkup(createElement(OperationsTimeline, { projection, timezone: "UTC" }));
      expect(html).toContain("Attendance originally observed — superseded");
      expect(html).toContain("Attendance corrected: did not attend");
      expect(html).toContain("🙂🙂🙂");
      expect(html).toContain("…");
    } finally {
      closeDb(db);
    }
  });

  it("does not infer activity from an event row or its lifecycle", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspaceFixture(db, "northstar");
      db.prepare(
        `INSERT INTO events
           (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
         VALUES ('empty-live-event', ?, 'Empty live event', 'UTC',
                 '2026-09-15T09:00:00.000Z', '2026-09-15T17:00:00.000Z', 'live',
                 '2026-08-12T07:00:00.000Z')`,
      ).run(northstar.workspaceId);

      const projection = getOperationsTimeline(db, northstar.workspaceId, "empty-live-event");
      expect(projection.entries).toEqual([]);
      expect(projection.stages.every((stage) => stage.count === 0)).toBe(true);
      const html = renderToStaticMarkup(createElement(OperationsTimeline, { projection, timezone: "UTC" }));
      expect(html).toContain("No operational activity records exist for this event.");
      expect(html).toContain("never manufacture progress");
    } finally {
      closeDb(db);
    }
  });

  it("bounds dense histories and identifies the latest chronological window", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const northstar = workspaceFixture(db, "northstar");
      db.prepare(
        `INSERT INTO events
           (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
         VALUES ('dense-event', ?, 'Dense event', 'UTC',
                 '2026-09-15T09:00:00.000Z', '2026-09-15T17:00:00.000Z', 'live',
                 '2026-08-12T07:00:00.000Z')`,
      ).run(northstar.workspaceId);
      db.prepare(
        `INSERT INTO program_units
           (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
         VALUES ('dense-unit', ?, 'dense-event', 'Dense session', 'session',
                 '2026-09-15T10:00:00.000Z', '2026-09-15T11:00:00.000Z', 600,
                 '2026-08-12T07:00:00.000Z')`,
      ).run(northstar.workspaceId);
      const insert = db.prepare(
        `INSERT INTO observations
           (id, workspace_id, event_id, person_id, program_unit_id, observation_type,
            observed_at, source, idempotency_key, recorded_at)
         VALUES (?, ?, 'dense-event', ?, 'dense-unit', 'attendance', ?,
                 'synthetic-unit-test', ?, ?)`,
      );
      for (let index = 0; index < OPERATIONS_TIMELINE_LIMIT + 2; index += 1) {
        const suffix = String(index).padStart(4, "0");
        insert.run(
          `dense-observation-${suffix}`,
          northstar.workspaceId,
          northstar.personId,
          new Date(Date.UTC(2026, 7, 12, 7, 0, index)).toISOString(),
          `dense-key-${suffix}`,
          new Date(Date.UTC(2026, 7, 12, 8, 0, index)).toISOString(),
        );
      }

      const projection = getOperationsTimeline(db, northstar.workspaceId, "dense-event");
      expect(projection.truncated).toBe(true);
      expect(projection.entries).toHaveLength(OPERATIONS_TIMELINE_LIMIT);
      expect(projection.entries[0]?.sourceId).toBe("dense-observation-0002");
      expect(projection.entries.at(-1)?.sourceId).toBe("dense-observation-0501");
      expect(projection.stages.find((stage) => stage.stage === "operational")).toMatchObject({
        count: OPERATIONS_TIMELINE_LIMIT,
        truncated: true,
      });
    } finally {
      closeDb(db);
    }
  });
});
