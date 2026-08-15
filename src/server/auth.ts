import { withTransaction, type Db } from "./db";
import { deterministicUuid, nowIso, randomToken, sha256Hex } from "./canonical";
import { writeDenialAudit } from "./services/audit";
import { requireRuntimeDataMode } from "./runtime-mode";

export const SESSION_COOKIE = "sympose_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
export const PRODUCTION_SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export interface SessionInfo {
  id: string;
  tokenHash: string;
  accountId: string;
  workspaceId: string;
  expiresAt: string;
  email: string;
  displayName: string;
  role: string;
  workspaceSlug: string;
  workspaceName: string;
}

export type Capability = "phase0.pipeline.manage" | "connectors.manage" | "cfp.review";

const ROLE_CAPABILITIES: Readonly<Record<string, readonly Capability[]>> = {
  // The first production workspace account uses the existing organizer role. "Owner" is a
  // bootstrap lifecycle description, not a second authorization grammar.
  organizer: ["phase0.pipeline.manage", "connectors.manage"],
  workspace_admin: ["phase0.pipeline.manage", "connectors.manage"],
  event_manager: ["phase0.pipeline.manage"],
  program_manager: ["phase0.pipeline.manage"],
  communications_manager: [],
  reviewer: ["cfp.review"],
  read_only: [],
};

export class DenialError extends Error {
  readonly code: string;
  readonly target: string;

  constructor(code: string, message: string, target: string) {
    super(message);
    this.name = "DenialError";
    this.code = code;
    this.target = target;
  }
}

export function isDenialError(error: unknown): error is DenialError {
  return error instanceof DenialError;
}

export function roleHasCapability(role: string, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) === true;
}

/** A bounded DTO for capability-aware server-rendered navigation and controls. */
export function capabilitiesForSession(session: SessionInfo): readonly Capability[] {
  return Object.freeze([...(ROLE_CAPABILITIES[session.role] ?? [])]);
}

export function hasCapability(session: SessionInfo, capability: Capability): boolean {
  return roleHasCapability(session.role, capability);
}

export function requireCapability(
  db: Db,
  session: SessionInfo,
  capability: Capability,
): void {
  if (hasCapability(session, capability)) {
    return;
  }
  writeDenialAudit(db, session.workspaceId, {
    actorKind: "account",
    actorRef: session.accountId,
    code: "CAPABILITY_DENIED",
    targetType: "capability",
    targetId: capability,
    details: { role: session.role },
  });
  throw new DenialError(
    "CAPABILITY_DENIED",
    "This account is not authorized to perform that workspace action.",
    capability,
  );
}

export interface CreateSessionResult {
  token: string;
  session: SessionInfo;
}

export function rotateSession(
  db: Db,
  previousToken: string | undefined,
  accountId: string,
  workspaceId: string,
): CreateSessionResult {
  return withTransaction(db, () => {
    revokeSession(db, previousToken);
    return createSession(db, accountId, workspaceId);
  });
}

export function createSession(db: Db, accountId: string, workspaceId: string): CreateSessionResult {
  const account = db
    .prepare("SELECT id FROM accounts WHERE id = ? AND workspace_id = ?")
    .get(accountId, workspaceId) as { id: string } | undefined;
  if (!account) {
    throw new DenialError(
      "SESSION_WORKSPACE_MISMATCH",
      "The account does not belong to the requested workspace.",
      workspaceId,
    );
  }
  const token = randomToken();
  const tokenHash = sha256Hex(token);
  const id = deterministicUuid(`session:${tokenHash.slice(0, 24)}`);
  const expiresAt = new Date(
    Date.now() + (requireRuntimeDataMode() === "production" ? PRODUCTION_SESSION_TTL_MS : SESSION_TTL_MS),
  ).toISOString();
  db.prepare(
    "INSERT INTO sessions (id, token_hash, account_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, tokenHash, accountId, workspaceId, nowIso(), expiresAt);
  return { token, session: requireSessionByHash(db, tokenHash) };
}

export function sessionCookieOptions(): Readonly<{
  httpOnly: true;
  sameSite: "strict" | "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
  priority: "high";
}> {
  const productionMode = requireRuntimeDataMode() === "production";
  return Object.freeze({
    httpOnly: true,
    sameSite: productionMode ? "strict" : "lax",
    path: "/",
    secure: productionMode || process.env.NODE_ENV === "production",
    maxAge: Math.floor((productionMode ? PRODUCTION_SESSION_TTL_MS : SESSION_TTL_MS) / 1_000),
    priority: "high",
  });
}

export function resolveSession(db: Db, token: string | undefined): SessionInfo | null {
  if (!token) {
    return null;
  }
  const hash = sha256Hex(token);
  try {
    return requireSessionByHash(db, hash);
  } catch {
    return null;
  }
}

export function revokeSession(db: Db, token: string | undefined): void {
  if (!token) {
    return;
  }
  const hash = sha256Hex(token);
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
}

function requireSessionByHash(db: Db, hash: string): SessionInfo {
  const row = db
    .prepare(
      `SELECT s.id, s.token_hash, s.account_id, s.workspace_id, s.expires_at,
              a.email, a.display_name, a.role, w.slug AS workspace_slug, w.name AS workspace_name
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id AND a.workspace_id = s.workspace_id
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.token_hash = ?`,
    )
    .get(hash) as
    | {
        id: string;
        token_hash: string;
        account_id: string;
        workspace_id: string;
        expires_at: string;
        email: string;
        display_name: string;
        role: string;
        workspace_slug: string;
        workspace_name: string;
      }
    | undefined;
  if (!row) {
    throw new DenialError("SESSION_INVALID", "No active server session.", "session");
  }
  if (row.expires_at < nowIso()) {
    throw new DenialError("SESSION_EXPIRED", "Server session has expired; sign in again.", "session");
  }
  return {
    id: row.id,
    tokenHash: row.token_hash,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    expiresAt: row.expires_at,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    workspaceSlug: row.workspace_slug,
    workspaceName: row.workspace_name,
  };
}

/**
 * Deterministic cross-workspace denial: every application query and command derives the
 * workspace from the server session. A client-supplied workspace (slug or id) that does not
 * match the session is always refused with the same stable code and message.
 */
export function assertWorkspaceMatch(session: SessionInfo, requestedSlug: string): void {
  if (session.workspaceSlug !== requestedSlug) {
    throw new DenialError(
      "CROSS_WORKSPACE_DENIED",
      `Workspace "${requestedSlug}" is not the session's workspace ("${session.workspaceSlug}"). Every query and command is scoped by the server session; client-supplied workspace identifiers are never trusted.`,
      requestedSlug,
    );
  }
}

export function describeDenial(error: DenialError): { code: string; message: string; target: string } {
  return { code: error.code, message: error.message, target: error.target };
}
