import { DatabaseSync } from "node:sqlite";

export type LegacySchemaVersion = 1 | 2;
export const LEGACY_FIXTURE_BASE_COMMIT = "1c6fb60ae23b831597edc37c3cae2dd381f48474";
export const LEGACY_SCHEMA_MANIFEST_SHA256 =
  "898ad03da81ef4db425d4028c66bdf1bb2b84b01578caa325fd317df58ec5533";

/**
 * Literal frozen V1/V2 SQL. It intentionally does not import or derive from the candidate V3
 * schema. V1 and V2 share this accepted physical baseline; their metadata differs only in the
 * schema_version row.
 */
export const LEGACY_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA recursive_triggers = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'organizer',
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (workspace_id, provider, source_ref, version)
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  canonical_email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  organization TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, canonical_email)
);

CREATE TABLE IF NOT EXISTS source_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  link_decision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS cohort_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, id, version)
);

CREATE TABLE IF NOT EXISTS cohort_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  cohort_definition_id TEXT NOT NULL REFERENCES cohort_definitions(id),
  definition_version INTEGER NOT NULL,
  as_of TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  member_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cohort_snapshot_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  snapshot_id TEXT NOT NULL REFERENCES cohort_snapshots(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  rank INTEGER NOT NULL,
  why_in TEXT NOT NULL,
  UNIQUE (snapshot_id, person_id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'planning',
  current_plan_version_id TEXT,
  current_release_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS program_units (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  unit_type TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, event_id, name)
);

CREATE TABLE IF NOT EXISTS plan_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  status TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  input_manifest_json TEXT NOT NULL,
  compiler TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  run_id TEXT NOT NULL REFERENCES plan_runs(id),
  version_number INTEGER NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, version_number)
);

CREATE TABLE IF NOT EXISTS plan_states (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id),
  state TEXT NOT NULL,
  actor_account_id TEXT REFERENCES accounts(id),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_assignments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  program_unit_id TEXT NOT NULL REFERENCES program_units(id),
  assignment_type TEXT NOT NULL,
  explanation TEXT NOT NULL,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  UNIQUE (plan_version_id, person_id, program_unit_id, assignment_type)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, event_id, plan_version_id)
);

CREATE TABLE IF NOT EXISTS commitment_offers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  terms_json TEXT NOT NULL,
  terms_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offered',
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, event_id, plan_version_id, person_id)
);

CREATE TABLE IF NOT EXISTS commitment_responses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  offer_id TEXT NOT NULL REFERENCES commitment_offers(id),
  response TEXT NOT NULL,
  responded_at TEXT NOT NULL,
  actor_person_id TEXT NOT NULL REFERENCES people(id),
  UNIQUE (workspace_id, offer_id)
);

CREATE TABLE IF NOT EXISTS publication_releases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id),
  audience_policy_version INTEGER NOT NULL,
  commitment_watermark INTEGER NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  content_json TEXT NOT NULL,
  sealed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_agendas (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  release_id TEXT NOT NULL REFERENCES publication_releases(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  agenda_json TEXT NOT NULL,
  UNIQUE (workspace_id, release_id, person_id)
);

CREATE TABLE IF NOT EXISTS portal_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  release_id TEXT NOT NULL REFERENCES publication_releases(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'agenda',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  revoked_by TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  program_unit_id TEXT NOT NULL REFERENCES program_units(id),
  observation_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  corrected_by TEXT,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_kind TEXT NOT NULL,
  actor_ref TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_workspace ON source_records(workspace_id);
CREATE INDEX IF NOT EXISTS idx_people_workspace ON people(workspace_id);
CREATE INDEX IF NOT EXISTS idx_source_links_person ON source_links(person_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_members_person ON cohort_snapshot_members(person_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_workspace ON cohort_snapshots(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plan_versions_event ON plan_versions(event_id);
CREATE INDEX IF NOT EXISTS idx_assignments_person ON plan_assignments(person_id);
CREATE INDEX IF NOT EXISTS idx_offers_person ON commitment_offers(person_id);
CREATE INDEX IF NOT EXISTS idx_agendas_release ON personal_agendas(release_id);
CREATE INDEX IF NOT EXISTS idx_observations_person ON observations(person_id);
CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_events(workspace_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_sessions_workspace_guard BEFORE INSERT ON sessions
WHEN NOT EXISTS (
  SELECT 1 FROM accounts a
  WHERE a.id = NEW.account_id AND a.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'sessions workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_source_links_workspace_guard BEFORE INSERT ON source_links
WHEN NOT EXISTS (
  SELECT 1 FROM people p, source_records r
  WHERE p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id
    AND r.id = NEW.source_record_id AND r.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'source_links workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cohort_snapshots_workspace_guard BEFORE INSERT ON cohort_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM cohort_definitions d
  WHERE d.id = NEW.cohort_definition_id AND d.workspace_id = NEW.workspace_id
    AND d.version = NEW.definition_version
)
BEGIN SELECT RAISE(ABORT, 'cohort_snapshots workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_snapshot_members_workspace_guard BEFORE INSERT ON cohort_snapshot_members
WHEN NOT EXISTS (
  SELECT 1 FROM cohort_snapshots s, people p
  WHERE s.id = NEW.snapshot_id AND s.workspace_id = NEW.workspace_id
    AND p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'cohort_snapshot_members workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_program_units_workspace_guard BEFORE INSERT ON program_units
WHEN NOT EXISTS (
  SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'program_units workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_runs_workspace_guard BEFORE INSERT ON plan_runs
WHEN NOT EXISTS (
  SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'plan_runs workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_versions_workspace_guard BEFORE INSERT ON plan_versions
WHEN NOT EXISTS (
  SELECT 1 FROM events e, plan_runs r
  WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
    AND r.id = NEW.run_id AND r.workspace_id = NEW.workspace_id AND r.event_id = NEW.event_id
)
BEGIN SELECT RAISE(ABORT, 'plan_versions workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_states_workspace_guard BEFORE INSERT ON plan_states
WHEN NOT EXISTS (
  SELECT 1 FROM plan_versions p
  WHERE p.id = NEW.plan_version_id AND p.workspace_id = NEW.workspace_id
)
OR (NEW.actor_account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a
  WHERE a.id = NEW.actor_account_id AND a.workspace_id = NEW.workspace_id
))
BEGIN SELECT RAISE(ABORT, 'plan_states workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_assignments_workspace_guard BEFORE INSERT ON plan_assignments
WHEN NOT EXISTS (
  SELECT 1 FROM plan_versions pv, people p, program_units u
  WHERE pv.id = NEW.plan_version_id AND pv.workspace_id = NEW.workspace_id
    AND p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id
    AND u.id = NEW.program_unit_id AND u.workspace_id = NEW.workspace_id
    AND u.event_id = pv.event_id
)
BEGIN SELECT RAISE(ABORT, 'plan_assignments workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_approvals_workspace_guard BEFORE INSERT ON approvals
WHEN NOT EXISTS (
  SELECT 1 FROM events e, plan_versions p, accounts a
  WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
    AND p.id = NEW.plan_version_id AND p.workspace_id = NEW.workspace_id
    AND p.event_id = NEW.event_id
    AND a.id = NEW.actor_account_id AND a.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'approvals workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_offers_workspace_guard BEFORE INSERT ON commitment_offers
WHEN NOT EXISTS (
  SELECT 1 FROM events e, plan_versions pv, people p
  WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
    AND pv.id = NEW.plan_version_id AND pv.workspace_id = NEW.workspace_id
    AND pv.event_id = NEW.event_id
    AND p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'commitment_offers workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_responses_workspace_guard BEFORE INSERT ON commitment_responses
WHEN NOT EXISTS (
  SELECT 1 FROM commitment_offers o, people p
  WHERE o.id = NEW.offer_id AND o.workspace_id = NEW.workspace_id
    AND p.id = NEW.actor_person_id AND p.workspace_id = NEW.workspace_id
    AND p.id = o.person_id
)
BEGIN SELECT RAISE(ABORT, 'commitment_responses workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_releases_workspace_guard BEFORE INSERT ON publication_releases
WHEN NOT EXISTS (
  SELECT 1 FROM events e, plan_versions p
  WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
    AND p.id = NEW.plan_version_id AND p.workspace_id = NEW.workspace_id
    AND p.event_id = NEW.event_id
)
BEGIN SELECT RAISE(ABORT, 'publication_releases workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_agendas_workspace_guard BEFORE INSERT ON personal_agendas
WHEN NOT EXISTS (
  SELECT 1 FROM publication_releases r, people p
  WHERE r.id = NEW.release_id AND r.workspace_id = NEW.workspace_id
    AND p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'personal_agendas workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_tokens_workspace_guard BEFORE INSERT ON portal_tokens
WHEN NOT EXISTS (
  SELECT 1 FROM publication_releases r, people p
  WHERE r.id = NEW.release_id AND r.workspace_id = NEW.workspace_id
    AND p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'portal_tokens workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_observations_workspace_guard BEFORE INSERT ON observations
WHEN NOT EXISTS (
  SELECT 1 FROM events e, people p, program_units u
  WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
    AND p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id
    AND u.id = NEW.program_unit_id AND u.workspace_id = NEW.workspace_id
    AND u.event_id = NEW.event_id
)
BEGIN SELECT RAISE(ABORT, 'observations workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_events_pointer_guard BEFORE UPDATE ON events
WHEN (NEW.current_plan_version_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM plan_versions p
  WHERE p.id = NEW.current_plan_version_id AND p.workspace_id = NEW.workspace_id
    AND p.event_id = NEW.id
))
OR (NEW.current_release_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM publication_releases r
  WHERE r.id = NEW.current_release_id AND r.workspace_id = NEW.workspace_id
    AND r.event_id = NEW.id
))
BEGIN SELECT RAISE(ABORT, 'events current pointer workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cohort_definitions_immutable BEFORE UPDATE ON cohort_definitions
BEGIN SELECT RAISE(ABORT, 'cohort_definitions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cohort_definitions_no_delete BEFORE DELETE ON cohort_definitions
BEGIN SELECT RAISE(ABORT, 'cohort_definitions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_source_records_immutable BEFORE UPDATE ON source_records
BEGIN SELECT RAISE(ABORT, 'source_records is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_source_records_no_delete BEFORE DELETE ON source_records
BEGIN SELECT RAISE(ABORT, 'source_records is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_source_links_immutable BEFORE UPDATE ON source_links
BEGIN SELECT RAISE(ABORT, 'source_links is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_source_links_no_delete BEFORE DELETE ON source_links
BEGIN SELECT RAISE(ABORT, 'source_links is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cohort_snapshots_immutable BEFORE UPDATE ON cohort_snapshots
BEGIN SELECT RAISE(ABORT, 'cohort_snapshots is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cohort_snapshots_no_delete BEFORE DELETE ON cohort_snapshots
BEGIN SELECT RAISE(ABORT, 'cohort_snapshots is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_snapshot_members_immutable BEFORE UPDATE ON cohort_snapshot_members
BEGIN SELECT RAISE(ABORT, 'cohort_snapshot_members is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_snapshot_members_no_delete BEFORE DELETE ON cohort_snapshot_members
BEGIN SELECT RAISE(ABORT, 'cohort_snapshot_members is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_runs_immutable BEFORE UPDATE ON plan_runs
BEGIN SELECT RAISE(ABORT, 'plan_runs is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_runs_no_delete BEFORE DELETE ON plan_runs
BEGIN SELECT RAISE(ABORT, 'plan_runs is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_versions_immutable BEFORE UPDATE ON plan_versions
BEGIN SELECT RAISE(ABORT, 'plan_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_versions_no_delete BEFORE DELETE ON plan_versions
BEGIN SELECT RAISE(ABORT, 'plan_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_assignments_immutable BEFORE UPDATE ON plan_assignments
BEGIN SELECT RAISE(ABORT, 'plan_assignments is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_assignments_no_delete BEFORE DELETE ON plan_assignments
BEGIN SELECT RAISE(ABORT, 'plan_assignments is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_states_immutable BEFORE UPDATE ON plan_states
BEGIN SELECT RAISE(ABORT, 'plan_states is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_states_no_delete BEFORE DELETE ON plan_states
BEGIN SELECT RAISE(ABORT, 'plan_states is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_approvals_immutable BEFORE UPDATE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_offers_immutable BEFORE UPDATE ON commitment_offers
BEGIN SELECT RAISE(ABORT, 'commitment_offers is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_offers_no_delete BEFORE DELETE ON commitment_offers
BEGIN SELECT RAISE(ABORT, 'commitment_offers is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_responses_immutable BEFORE UPDATE ON commitment_responses
BEGIN SELECT RAISE(ABORT, 'commitment_responses is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_responses_no_delete BEFORE DELETE ON commitment_responses
BEGIN SELECT RAISE(ABORT, 'commitment_responses is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_releases_immutable BEFORE UPDATE ON publication_releases
BEGIN SELECT RAISE(ABORT, 'publication_releases is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_releases_no_delete BEFORE DELETE ON publication_releases
BEGIN SELECT RAISE(ABORT, 'publication_releases is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_agendas_immutable BEFORE UPDATE ON personal_agendas
BEGIN SELECT RAISE(ABORT, 'personal_agendas is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_agendas_no_delete BEFORE DELETE ON personal_agendas
BEGIN SELECT RAISE(ABORT, 'personal_agendas is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_tokens_core_immutable BEFORE UPDATE ON portal_tokens
WHEN NEW.workspace_id != OLD.workspace_id
  OR NEW.release_id != OLD.release_id
  OR NEW.person_id != OLD.person_id
  OR NEW.token_hash != OLD.token_hash
  OR NEW.scope != OLD.scope
  OR NEW.created_at != OLD.created_at
  OR NEW.expires_at != OLD.expires_at
  OR OLD.revoked_at IS NOT NULL
  OR (NEW.revoked_at IS NOT NULL AND (
    NEW.revoked_reason IS NULL OR NEW.revoked_by IS NULL OR NOT EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.id = NEW.revoked_by AND a.workspace_id = NEW.workspace_id
    )
  ))
BEGIN SELECT RAISE(ABORT, 'portal_tokens core fields are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_tokens_no_delete BEFORE DELETE ON portal_tokens
BEGIN SELECT RAISE(ABORT, 'portal_tokens is retained for audit'); END;
CREATE TRIGGER IF NOT EXISTS trg_observations_immutable BEFORE UPDATE ON observations
BEGIN SELECT RAISE(ABORT, 'observations is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_observations_no_delete BEFORE DELETE ON observations
BEGIN SELECT RAISE(ABORT, 'observations is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_immutable BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is immutable'); END;
`;

export interface LegacyWorkspaceMarker {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}

export function createLegacyDatabase(
  options: { readonly path?: string; readonly schemaVersion: LegacySchemaVersion },
): DatabaseSync {
  if (options.schemaVersion !== 1 && options.schemaVersion !== 2) {
    throw new RangeError("legacy schema version must be 1 or 2");
  }
  const db = new DatabaseSync(options.path ?? ":memory:");
  try {
    db.exec(LEGACY_SCHEMA_SQL);
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(options.schemaVersion),
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function insertWorkspaceMarker(db: DatabaseSync, marker: LegacyWorkspaceMarker): void {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(marker.id, marker.slug, marker.name, marker.createdAt);
}
