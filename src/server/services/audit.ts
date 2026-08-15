import type { Db } from "../db";
import { uuid } from "../canonical";

export type ActorKind = "account" | "person" | "token" | "system";

export interface AuditInput {
  actorKind: ActorKind;
  actorRef: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

export function writeAudit(db: Db, workspaceId: string, input: AuditInput): void {
  db.prepare(
    `INSERT INTO audit_events (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    workspaceId,
    input.actorKind,
    input.actorRef,
    input.action,
    input.targetType ?? null,
    input.targetId ?? null,
    input.details ? JSON.stringify(input.details) : null,
    new Date().toISOString(),
  );
}

export function writeDenialAudit(
  db: Db,
  workspaceId: string,
  input: {
    actorKind: "account" | "person" | "token" | "system";
    actorRef: string;
    code: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
  },
): void {
  writeAudit(db, workspaceId, {
    actorKind: input.actorKind,
    actorRef: input.actorRef,
    action: "security.access.denied",
    targetType: input.targetType,
    targetId: input.targetId,
    details: { ...input.details, code: input.code },
  });
}
