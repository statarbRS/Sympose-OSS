import { describe, expect, it } from "vitest";

import { fingerprintOf } from "@/server/canonical";
import { closeDb, openDb, type Db } from "@/server/db";
import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_WORKSPACE_ID,
  seedEvaluatorDemo,
} from "@/server/evaluator-demo";
import { seedWorkspaces } from "@/server/seed";
import {
  parseSealedReleaseContent,
  validatePublicReleaseForRead,
  type SealedReleaseContent,
} from "@/server/services/publication";
import { scheduleContentFingerprint } from "@/server/services/scheduling/deterministic";
import { readScheduleDraft } from "@/server/services/scheduling/persistence";

const scope = { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID } as const;

function setup(): Db {
  const db = openDb({ path: ":memory:", seed: false });
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  return db;
}

function currentReleaseRow(db: Db): { releaseId: string; contentJson: string } {
  const row = db.prepare(
    `SELECT release.id AS releaseId, release.content_json AS contentJson
       FROM events event_row
       JOIN publication_releases release
         ON release.id = event_row.current_release_id
        AND release.workspace_id = event_row.workspace_id
        AND release.event_id = event_row.id
      WHERE event_row.workspace_id = ? AND event_row.id = ?`,
  ).get(scope.workspaceId, scope.eventId) as { releaseId: string; contentJson: string } | undefined;
  if (!row) throw new Error("current release fixture unavailable");
  return row;
}

describe("publication schedule compatibility and approval evidence", () => {
  it("parses and validates a retained v1 schedule release through historical and current reads", () => {
    const db = setup();
    try {
      const row = currentReleaseRow(db);
      const current = parseSealedReleaseContent(row.contentJson);
      if (!current.schedule || current.schedule.schema !== "publication-schedule/v2") {
        throw new Error("v2 schedule fixture unavailable");
      }
      const {
        sourceScheduleApprovalId: _approvalId,
        sourceScheduleApprovalAuditId: _approvalAuditId,
        sourceScheduleApprovalFingerprint: _approvalFingerprint,
        ...legacyBase
      } = current.schedule;
      const legacySchedule = {
        ...legacyBase,
        schema: "publication-schedule/v1" as const,
        scheduleFingerprint: scheduleContentFingerprint(readScheduleDraft(db, scope).schedule),
      };
      const legacyContent: SealedReleaseContent = { ...current, schedule: legacySchedule };
      const legacyFingerprint = fingerprintOf(legacyContent);

      db.exec(`
        DROP TRIGGER trg_releases_immutable;
        DROP TRIGGER trg_agendas_immutable;
        DROP TRIGGER trg_audit_immutable;
      `);
      db.prepare(
        "UPDATE publication_releases SET content_json = ?, fingerprint = ? WHERE id = ? AND workspace_id = ?",
      ).run(JSON.stringify(legacyContent), legacyFingerprint, row.releaseId, scope.workspaceId);
      const agendaRows = db.prepare(
        "SELECT id, agenda_json AS agendaJson FROM personal_agendas WHERE workspace_id = ? AND release_id = ?",
      ).all(scope.workspaceId, row.releaseId) as Array<{ id: string; agendaJson: string }>;
      for (const agendaRow of agendaRows) {
        const agenda = JSON.parse(agendaRow.agendaJson) as Record<string, unknown>;
        db.prepare("UPDATE personal_agendas SET agenda_json = ? WHERE id = ? AND workspace_id = ?")
          .run(JSON.stringify({ ...agenda, fingerprint: legacyFingerprint }), agendaRow.id, scope.workspaceId);
      }
      const sealAudit = db.prepare(
        `SELECT id, details_json AS detailsJson FROM audit_events
          WHERE workspace_id = ? AND action = 'publication.release.sealed'
            AND target_type = 'publication_release' AND target_id = ?`,
      ).get(scope.workspaceId, row.releaseId) as { id: string; detailsJson: string };
      const details = JSON.parse(sealAudit.detailsJson) as Record<string, unknown>;
      db.prepare("UPDATE audit_events SET details_json = ? WHERE id = ? AND workspace_id = ?")
        .run(JSON.stringify({
          ...details,
          fingerprint: legacyFingerprint,
          sealedContentFingerprint: legacyFingerprint,
          scheduleManifestFingerprint: fingerprintOf(legacySchedule),
        }), sealAudit.id, scope.workspaceId);

      expect(parseSealedReleaseContent(JSON.stringify(legacyContent)).schedule?.schema)
        .toBe("publication-schedule/v1");
      expect(validatePublicReleaseForRead(db, {
        ...scope,
        releaseId: row.releaseId,
        mode: "HISTORICAL",
      })?.content.schedule?.schema).toBe("publication-schedule/v1");
      expect(validatePublicReleaseForRead(db, {
        ...scope,
        releaseId: row.releaseId,
        mode: "CURRENT",
      })?.content.schedule?.schema).toBe("publication-schedule/v1");
    } finally {
      closeDb(db);
    }
  });

  it("fails closed when a v2 release's exact approval audit evidence is tampered", () => {
    const db = setup();
    try {
      const row = currentReleaseRow(db);
      expect(validatePublicReleaseForRead(db, { ...scope, releaseId: row.releaseId, mode: "CURRENT" }))
        .not.toBeNull();
      db.exec("DROP TRIGGER trg_audit_immutable");
      const approvalAudit = db.prepare(
        `SELECT id, details_json AS detailsJson FROM audit_events
          WHERE workspace_id = ? AND action = 'schedule.approved' AND target_id = ?`,
      ).get(scope.workspaceId, scope.eventId) as { id: string; detailsJson: string };
      const details = JSON.parse(approvalAudit.detailsJson) as Record<string, unknown>;
      db.prepare("UPDATE audit_events SET details_json = ? WHERE id = ? AND workspace_id = ?")
        .run(JSON.stringify({ ...details, actorRole: "read_only" }), approvalAudit.id, scope.workspaceId);
      expect(validatePublicReleaseForRead(db, { ...scope, releaseId: row.releaseId, mode: "CURRENT" }))
        .toBeNull();
    } finally {
      closeDb(db);
    }
  });
});
