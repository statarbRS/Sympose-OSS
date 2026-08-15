export const SCHEMA_VERSION = 21;

export const CONNECTOR_CONNECTION_SCHEMA = "sympose-connector-connection/v1" as const;
export const CONNECTOR_CONNECTION_CONFIG_MAX_BYTES = 4 * 1024;

/** Mutable workspace/provider credential state; provider payload evidence remains in source_records. */
export const V20_CONNECTOR_CONNECTIONS_DDL = `
CREATE TABLE IF NOT EXISTS connector_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL CHECK (provider IN ('airtable', 'hubspot', 'salesforce')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  config_json TEXT NOT NULL CHECK (length(CAST(config_json AS BLOB)) BETWEEN 2 AND ${CONNECTOR_CONNECTION_CONFIG_MAX_BYTES}),
  secret_algorithm TEXT,
  secret_key_version TEXT,
  secret_iv TEXT,
  secret_ciphertext TEXT,
  secret_tag TEXT,
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at >= created_at),
  revoked_at TEXT,
  UNIQUE (workspace_id, provider),
  CHECK (
    (status = 'ACTIVE'
      AND revoked_at IS NULL
      AND secret_algorithm IS NOT NULL
      AND secret_key_version IS NOT NULL
      AND secret_iv IS NOT NULL
      AND secret_ciphertext IS NOT NULL
      AND secret_tag IS NOT NULL)
    OR
    (status = 'REVOKED'
      AND revoked_at IS NOT NULL
      AND secret_algorithm IS NULL
      AND secret_key_version IS NULL
      AND secret_iv IS NULL
      AND secret_ciphertext IS NULL
      AND secret_tag IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_connector_connections_workspace
  ON connector_connections(workspace_id, provider);
`;

export const CONNECTOR_RUN_EVIDENCE_MAX_BYTES = 16 * 1024;
export const CONNECTOR_RUN_CURSOR_MAX_BYTES = 2 * 1024;
export const CONNECTOR_RUN_MAX_PAGES = 20;
export const CONNECTOR_RUN_MAX_ITEMS = 1_000;
export const CONNECTOR_RUN_MAX_ATTEMPTS = 1_000;
export const CONNECTOR_RUN_MAX_PROVIDER_ATTEMPTS = 12;
export const PERSON_PROJECTION_DECISION_MAX_BYTES = 4 * 1024;
export const CONNECTOR_EXPORT_AUTHORITY_MAX_BYTES = 64 * 1024;
export const CONNECTOR_EXPORT_MANIFEST_MAX_BYTES = 1024 * 1024;

/**
 * Additive production authentication and durable connector execution state. Provider evidence is
 * staged here for explicit review; canonical identity remains in people/source_records/source_links.
 */
export const V21_PRODUCTION_CONNECTOR_RUNTIME_DDL = `
CREATE TABLE IF NOT EXISTS production_bootstrap_challenges (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kdf TEXT NOT NULL CHECK (kdf = 'scrypt-v1'),
  salt TEXT,
  verifier TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > issued_at),
  consumed_at TEXT,
  consumed_by_account_id TEXT REFERENCES accounts(id),
  invalidated_at TEXT,
  CHECK (NOT (consumed_at IS NOT NULL AND invalidated_at IS NOT NULL)),
  CHECK (
    (consumed_at IS NULL AND invalidated_at IS NULL AND salt IS NOT NULL AND verifier IS NOT NULL AND consumed_by_account_id IS NULL)
    OR
    (consumed_at IS NOT NULL AND invalidated_at IS NULL AND salt IS NULL AND verifier IS NULL AND consumed_by_account_id IS NOT NULL)
    OR
    (consumed_at IS NULL AND invalidated_at IS NOT NULL AND salt IS NULL AND verifier IS NULL AND consumed_by_account_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS account_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kdf TEXT NOT NULL CHECK (kdf = 'scrypt-v1'),
  salt TEXT NOT NULL CHECK (length(salt) = 32 AND salt NOT GLOB '*[^0-9a-f]*'),
  verifier TEXT NOT NULL CHECK (length(verifier) = 128 AND verifier NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS auth_login_guards (
  identity_hash TEXT PRIMARY KEY CHECK (length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'),
  failed_attempts INTEGER NOT NULL CHECK (typeof(failed_attempts) = 'integer' AND failed_attempts BETWEEN 1 AND 5),
  blocked_until TEXT,
  last_failed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_global_guards (
  attempt_kind TEXT PRIMARY KEY CHECK (attempt_kind IN ('LOGIN', 'BOOTSTRAP')),
  window_started_at TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL CHECK (typeof(failed_attempts) = 'integer' AND failed_attempts BETWEEN 0 AND 20),
  blocked_until TEXT,
  updated_at TEXT NOT NULL CHECK (updated_at >= window_started_at)
);

CREATE TABLE IF NOT EXISTS auth_attempt_leases (
  id TEXT PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('LOGIN', 'BOOTSTRAP')),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > acquired_at)
);

CREATE TABLE IF NOT EXISTS connector_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  connection_id TEXT NOT NULL REFERENCES connector_connections(id),
  provider TEXT NOT NULL CHECK (provider IN ('airtable', 'hubspot', 'salesforce')),
  operation TEXT NOT NULL CHECK (operation IN ('TEST', 'IMPORT', 'EXPORT')),
  state TEXT NOT NULL CHECK (state IN ('CREATED', 'RUNNING', 'PREVIEW_READY', 'CONFIRMED', 'SUCCEEDED', 'PARTIAL', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'UNKNOWN')),
  connection_version INTEGER NOT NULL CHECK (typeof(connection_version) = 'integer' AND connection_version >= 1),
  config_fingerprint TEXT NOT NULL CHECK (length(config_fingerprint) = 64 AND config_fingerprint NOT GLOB '*[^0-9a-f]*'),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
  provider_cursor TEXT CHECK (provider_cursor IS NULL OR length(CAST(provider_cursor AS BLOB)) BETWEEN 1 AND ${CONNECTOR_RUN_CURSOR_MAX_BYTES}),
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(page_count) = 'integer' AND page_count BETWEEN 0 AND ${CONNECTOR_RUN_MAX_PAGES}),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(item_count) = 'integer' AND item_count BETWEEN 0 AND ${CONNECTOR_RUN_MAX_ITEMS}),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND ${CONNECTOR_RUN_MAX_ATTEMPTS}),
  retry_classification TEXT NOT NULL DEFAULT 'NONE' CHECK (retry_classification IN ('NONE', 'RETRYABLE', 'TERMINAL', 'AMBIGUOUS', 'STALE')),
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 96 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  confirmation_token_hash TEXT CHECK (confirmation_token_hash IS NULL OR (length(confirmation_token_hash) = 64 AND confirmation_token_hash NOT GLOB '*[^0-9a-f]*')),
  confirmation_expires_at TEXT,
  confirmed_at TEXT,
  confirmed_by_account_id TEXT REFERENCES accounts(id),
  started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at >= created_at),
  completed_at TEXT,
  UNIQUE (workspace_id, connection_id, operation, idempotency_key_hash),
  CHECK ((confirmation_token_hash IS NULL) = (confirmation_expires_at IS NULL)),
  CHECK ((confirmed_at IS NULL) = (confirmed_by_account_id IS NULL))
);

CREATE TABLE IF NOT EXISTS connector_run_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT NOT NULL REFERENCES connector_runs(id),
  attempt_number INTEGER NOT NULL CHECK (typeof(attempt_number) = 'integer' AND attempt_number BETWEEN 1 AND ${CONNECTOR_RUN_MAX_ATTEMPTS}),
  cursor_before TEXT CHECK (cursor_before IS NULL OR length(CAST(cursor_before AS BLOB)) BETWEEN 1 AND ${CONNECTOR_RUN_CURSOR_MAX_BYTES}),
  cursor_after TEXT CHECK (cursor_after IS NULL OR length(CAST(cursor_after AS BLOB)) BETWEEN 1 AND ${CONNECTOR_RUN_CURSOR_MAX_BYTES}),
  provider_attempts INTEGER NOT NULL CHECK (typeof(provider_attempts) = 'integer' AND provider_attempts BETWEEN 0 AND ${CONNECTOR_RUN_MAX_PROVIDER_ATTEMPTS}),
  page_items INTEGER NOT NULL CHECK (typeof(page_items) = 'integer' AND page_items BETWEEN 0 AND ${CONNECTOR_RUN_MAX_ITEMS}),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'UNKNOWN', 'STALE')),
  retry_classification TEXT NOT NULL CHECK (retry_classification IN ('NONE', 'RETRYABLE', 'TERMINAL', 'AMBIGUOUS', 'STALE')),
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 96 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL CHECK (completed_at >= started_at),
  UNIQUE (workspace_id, run_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS connector_import_preview_rows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT NOT NULL REFERENCES connector_runs(id),
  provider TEXT NOT NULL CHECK (provider IN ('airtable', 'hubspot', 'salesforce')),
  provider_record_id TEXT NOT NULL CHECK (length(CAST(provider_record_id AS BLOB)) BETWEEN 1 AND 512),
  external_identity TEXT NOT NULL CHECK (length(CAST(external_identity AS BLOB)) BETWEEN 1 AND 768),
  normalized_email TEXT,
  full_name TEXT,
  organization TEXT,
  title TEXT,
  source_version TEXT NOT NULL CHECK (length(CAST(source_version AS BLOB)) BETWEEN 1 AND 512),
  evidence_json TEXT NOT NULL CHECK (length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND ${CONNECTOR_RUN_EVIDENCE_MAX_BYTES}),
  evidence_fingerprint TEXT NOT NULL CHECK (length(evidence_fingerprint) = 64 AND evidence_fingerprint NOT GLOB '*[^0-9a-f]*'),
  disposition TEXT NOT NULL CHECK (disposition IN ('EVALUATING', 'CREATE', 'LINK', 'UPDATE', 'CONFLICT')),
  candidate_person_id TEXT REFERENCES people(id),
  candidate_person_fingerprint TEXT CHECK (
    candidate_person_fingerprint IS NULL OR
    (length(candidate_person_fingerprint) = 64 AND candidate_person_fingerprint NOT GLOB '*[^0-9a-f]*')
  ),
  conflict_code TEXT CHECK (conflict_code IS NULL OR (length(conflict_code) BETWEEN 1 AND 96 AND conflict_code NOT GLOB '*[^A-Z0-9_]*')),
  applied_source_record_id TEXT REFERENCES source_records(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (workspace_id, run_id, external_identity),
  CHECK ((candidate_person_id IS NULL) = (candidate_person_fingerprint IS NULL))
);

-- Typed organizer decisions that make connector-sourced Person projection changes reconstructable.
-- The mutable people row is only the current projection; it is not the provenance record.
CREATE TABLE IF NOT EXISTS person_projection_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  source_record_id TEXT NOT NULL REFERENCES source_records(id),
  import_run_id TEXT NOT NULL REFERENCES connector_runs(id),
  preview_row_id TEXT NOT NULL REFERENCES connector_import_preview_rows(id),
  decision_kind TEXT NOT NULL CHECK (decision_kind IN ('CREATE_FROM_SOURCE', 'UPDATE_FROM_SOURCE')),
  previous_projection_json TEXT CHECK (
    previous_projection_json IS NULL OR
    length(CAST(previous_projection_json AS BLOB)) BETWEEN 2 AND ${PERSON_PROJECTION_DECISION_MAX_BYTES}
  ),
  previous_projection_fingerprint TEXT CHECK (
    previous_projection_fingerprint IS NULL OR
    (length(previous_projection_fingerprint) = 64 AND previous_projection_fingerprint NOT GLOB '*[^0-9a-f]*')
  ),
  next_projection_json TEXT NOT NULL CHECK (
    length(CAST(next_projection_json AS BLOB)) BETWEEN 2 AND ${PERSON_PROJECTION_DECISION_MAX_BYTES}
  ),
  next_projection_fingerprint TEXT NOT NULL CHECK (
    length(next_projection_fingerprint) = 64 AND next_projection_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  decision_method TEXT NOT NULL CHECK (decision_method = 'EXPLICIT_ORGANIZER_CONFIRMATION'),
  confirmed_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, preview_row_id),
  CHECK (
    (decision_kind = 'CREATE_FROM_SOURCE'
      AND previous_projection_json IS NULL
      AND previous_projection_fingerprint IS NULL)
    OR
    (decision_kind = 'UPDATE_FROM_SOURCE'
      AND previous_projection_json IS NOT NULL
      AND previous_projection_fingerprint IS NOT NULL)
  )
);

-- Append-only external-recipient authority supplied by a trusted purpose/consent/policy
-- assembler. Connector managers cannot create this evidence through the connector surface.
CREATE TABLE IF NOT EXISTS connector_export_manifests (
  run_id TEXT PRIMARY KEY REFERENCES connector_runs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  connection_id TEXT NOT NULL REFERENCES connector_connections(id),
  connection_version INTEGER NOT NULL CHECK (
    typeof(connection_version) = 'integer' AND connection_version >= 1
  ),
  provider TEXT NOT NULL CHECK (provider IN ('airtable', 'hubspot', 'salesforce')),
  total_person_count INTEGER NOT NULL CHECK (
    typeof(total_person_count) = 'integer' AND total_person_count >= 0
  ),
  candidate_count INTEGER NOT NULL CHECK (
    typeof(candidate_count) = 'integer' AND candidate_count BETWEEN 0 AND ${CONNECTOR_RUN_MAX_ITEMS}
      AND candidate_count <= total_person_count
  ),
  candidates_json TEXT NOT NULL CHECK (
    length(CAST(candidates_json AS BLOB)) BETWEEN 2 AND ${CONNECTOR_EXPORT_MANIFEST_MAX_BYTES}
  ),
  candidates_fingerprint TEXT NOT NULL CHECK (
    length(candidates_fingerprint) = 64 AND candidates_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_export_authority_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  connection_id TEXT NOT NULL REFERENCES connector_connections(id),
  provider TEXT NOT NULL CHECK (provider IN ('airtable', 'hubspot', 'salesforce')),
  person_id TEXT NOT NULL REFERENCES people(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 1000000000),
  purpose_evidence_json TEXT NOT NULL CHECK (
    length(CAST(purpose_evidence_json AS BLOB)) BETWEEN 2 AND ${CONNECTOR_EXPORT_AUTHORITY_MAX_BYTES}
  ),
  purpose_evidence_fingerprint TEXT NOT NULL CHECK (
    length(purpose_evidence_fingerprint) = 64 AND purpose_evidence_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  retention_evidence_json TEXT NOT NULL CHECK (
    length(CAST(retention_evidence_json AS BLOB)) BETWEEN 2 AND ${CONNECTOR_EXPORT_AUTHORITY_MAX_BYTES}
  ),
  retention_evidence_fingerprint TEXT NOT NULL CHECK (
    length(retention_evidence_fingerprint) = 64 AND retention_evidence_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  authority_evidence_json TEXT NOT NULL CHECK (
    length(CAST(authority_evidence_json AS BLOB)) BETWEEN 2 AND ${CONNECTOR_EXPORT_AUTHORITY_MAX_BYTES}
  ),
  authority_evidence_fingerprint TEXT NOT NULL CHECK (
    length(authority_evidence_fingerprint) = 64 AND authority_evidence_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  recorded_at TEXT NOT NULL,
  UNIQUE (workspace_id, connection_id, person_id, version)
);

CREATE TABLE IF NOT EXISTS connector_export_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT NOT NULL REFERENCES connector_runs(id),
  connection_id TEXT NOT NULL REFERENCES connector_connections(id),
  connection_version INTEGER NOT NULL CHECK (
    typeof(connection_version) = 'integer' AND connection_version >= 1
  ),
  provider TEXT NOT NULL CHECK (provider IN ('airtable', 'hubspot', 'salesforce')),
  person_id TEXT NOT NULL REFERENCES people(id),
  authority_version_id TEXT REFERENCES connector_export_authority_versions(id),
  action_family TEXT NOT NULL CHECK (
    length(CAST(action_family AS BLOB)) BETWEEN 1 AND 128
      AND action_family NOT GLOB '*[^A-Z0-9_:-]*'
  ),
  projection_json TEXT NOT NULL CHECK (
    length(CAST(projection_json AS BLOB)) BETWEEN 2 AND ${PERSON_PROJECTION_DECISION_MAX_BYTES}
  ),
  projection_fingerprint TEXT NOT NULL CHECK (
    length(projection_fingerprint) = 64 AND projection_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  fact_families_json TEXT NOT NULL CHECK (
    length(CAST(fact_families_json AS BLOB)) BETWEEN 2 AND ${PERSON_PROJECTION_DECISION_MAX_BYTES}
  ),
  fact_families_fingerprint TEXT NOT NULL CHECK (
    length(fact_families_fingerprint) = 64 AND fact_families_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  preflight_input_json TEXT NOT NULL CHECK (
    length(CAST(preflight_input_json AS BLOB)) BETWEEN 2 AND ${CONNECTOR_EXPORT_AUTHORITY_MAX_BYTES}
  ),
  preflight_input_fingerprint TEXT NOT NULL CHECK (
    length(preflight_input_fingerprint) = 64 AND preflight_input_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  preflight_result_json TEXT NOT NULL CHECK (
    length(CAST(preflight_result_json AS BLOB)) BETWEEN 2 AND ${CONNECTOR_EXPORT_AUTHORITY_MAX_BYTES}
  ),
  preflight_result_fingerprint TEXT NOT NULL CHECK (
    length(preflight_result_fingerprint) = 64 AND preflight_result_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  decision_state TEXT NOT NULL CHECK (decision_state IN ('READY', 'BLOCKED', 'UNAVAILABLE')),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, run_id, person_id)
);

CREATE TABLE IF NOT EXISTS connector_export_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT NOT NULL REFERENCES connector_runs(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  provider_record_id TEXT NOT NULL CHECK (length(CAST(provider_record_id AS BLOB)) BETWEEN 1 AND 512),
  operation TEXT NOT NULL CHECK (operation IN ('CREATED', 'UPDATED')),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
  output_fingerprint TEXT NOT NULL CHECK (length(output_fingerprint) = 64 AND output_fingerprint NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, run_id, person_id),
  UNIQUE (workspace_id, run_id, provider_record_id)
);

CREATE INDEX IF NOT EXISTS idx_account_credentials_workspace ON account_credentials(workspace_id, account_id);
CREATE INDEX IF NOT EXISTS idx_auth_attempt_leases_expiry ON auth_attempt_leases(attempt_kind, expires_at, id);
CREATE INDEX IF NOT EXISTS idx_auth_login_guards_retention ON auth_login_guards(last_failed_at, identity_hash);
CREATE INDEX IF NOT EXISTS idx_connector_runs_workspace ON connector_runs(workspace_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_connector_attempts_run ON connector_run_attempts(workspace_id, run_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_connector_preview_run ON connector_import_preview_rows(workspace_id, run_id, disposition, id);
CREATE INDEX IF NOT EXISTS idx_connector_preview_email ON connector_import_preview_rows(workspace_id, normalized_email, run_id);
CREATE INDEX IF NOT EXISTS idx_person_projection_decisions_person
  ON person_projection_decisions(workspace_id, person_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_connector_export_authority_current
  ON connector_export_authority_versions(workspace_id, connection_id, person_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_connector_export_decision_run
  ON connector_export_decisions(workspace_id, run_id, decision_state, person_id);
CREATE INDEX IF NOT EXISTS idx_connector_export_run ON connector_export_receipts(workspace_id, run_id, person_id);

CREATE TRIGGER IF NOT EXISTS trg_account_credentials_workspace_guard BEFORE INSERT ON account_credentials
WHEN NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = NEW.account_id AND a.workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'account credential workspace mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_account_credentials_update_guard BEFORE UPDATE ON account_credentials
WHEN NEW.account_id IS NOT OLD.account_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = NEW.account_id AND a.workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'account credential workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_runs_scope_guard BEFORE INSERT ON connector_runs
WHEN NOT EXISTS (
  SELECT 1 FROM connector_connections c, accounts a
  WHERE c.id = NEW.connection_id AND c.workspace_id = NEW.workspace_id AND c.provider = NEW.provider
    AND a.id = NEW.created_by_account_id AND a.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'connector run scope mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_runs_binding_immutable BEFORE UPDATE ON connector_runs
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.connection_id IS NOT OLD.connection_id
  OR NEW.provider IS NOT OLD.provider OR NEW.operation IS NOT OLD.operation
  OR NEW.connection_version IS NOT OLD.connection_version OR NEW.config_fingerprint IS NOT OLD.config_fingerprint
  OR NEW.idempotency_key_hash IS NOT OLD.idempotency_key_hash OR NEW.input_fingerprint IS NOT OLD.input_fingerprint
  OR NEW.created_by_account_id IS NOT OLD.created_by_account_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'connector run binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_runs_update_scope_guard BEFORE UPDATE ON connector_runs
WHEN (NEW.confirmed_by_account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id = NEW.confirmed_by_account_id AND a.workspace_id = NEW.workspace_id
))
BEGIN SELECT RAISE(ABORT, 'connector run actor scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_runs_no_delete BEFORE DELETE ON connector_runs
BEGIN SELECT RAISE(ABORT, 'connector run is durable'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_attempts_scope_guard BEFORE INSERT ON connector_run_attempts
WHEN NOT EXISTS (SELECT 1 FROM connector_runs r WHERE r.id = NEW.run_id AND r.workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'connector attempt scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_attempts_immutable BEFORE UPDATE ON connector_run_attempts
BEGIN SELECT RAISE(ABORT, 'connector attempt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_attempts_no_delete BEFORE DELETE ON connector_run_attempts
BEGIN SELECT RAISE(ABORT, 'connector attempt is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_preview_scope_guard BEFORE INSERT ON connector_import_preview_rows
WHEN NOT EXISTS (SELECT 1 FROM connector_runs r WHERE r.id = NEW.run_id AND r.workspace_id = NEW.workspace_id AND r.provider = NEW.provider)
  OR (NEW.candidate_person_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id = NEW.candidate_person_id AND p.workspace_id = NEW.workspace_id))
BEGIN SELECT RAISE(ABORT, 'connector preview scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_preview_update_guard BEFORE UPDATE ON connector_import_preview_rows
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.run_id IS NOT OLD.run_id
  OR NEW.provider IS NOT OLD.provider OR NEW.provider_record_id IS NOT OLD.provider_record_id
  OR NEW.external_identity IS NOT OLD.external_identity OR NEW.normalized_email IS NOT OLD.normalized_email
  OR NEW.full_name IS NOT OLD.full_name OR NEW.organization IS NOT OLD.organization OR NEW.title IS NOT OLD.title
  OR NEW.source_version IS NOT OLD.source_version OR NEW.evidence_json IS NOT OLD.evidence_json
  OR NEW.evidence_fingerprint IS NOT OLD.evidence_fingerprint OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.disposition <> 'EVALUATING' AND NEW.disposition IS NOT OLD.disposition)
  OR (OLD.disposition <> 'EVALUATING' AND NEW.candidate_person_id IS NOT OLD.candidate_person_id)
  OR (OLD.disposition <> 'EVALUATING' AND NEW.candidate_person_fingerprint IS NOT OLD.candidate_person_fingerprint)
  OR (OLD.disposition <> 'EVALUATING' AND NEW.conflict_code IS NOT OLD.conflict_code)
  OR (OLD.applied_source_record_id IS NOT NULL AND NEW.applied_source_record_id IS NOT OLD.applied_source_record_id)
  OR (NEW.candidate_person_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM people p WHERE p.id = NEW.candidate_person_id AND p.workspace_id = NEW.workspace_id
  ))
  OR (NEW.applied_source_record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM source_records r WHERE r.id = NEW.applied_source_record_id AND r.workspace_id = NEW.workspace_id
  ))
BEGIN SELECT RAISE(ABORT, 'connector preview evidence mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_preview_no_delete BEFORE DELETE ON connector_import_preview_rows
BEGIN SELECT RAISE(ABORT, 'connector preview evidence is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_person_projection_decisions_scope_guard
BEFORE INSERT ON person_projection_decisions
WHEN sympose_pd01_canonical_json(NEW.next_projection_json) IS NOT NEW.next_projection_json
  OR sympose_pd01_fingerprint(NEW.next_projection_json) IS NOT NEW.next_projection_fingerprint
  OR (NEW.previous_projection_json IS NOT NULL AND (
    sympose_pd01_canonical_json(NEW.previous_projection_json) IS NOT NEW.previous_projection_json
    OR sympose_pd01_fingerprint(NEW.previous_projection_json) IS NOT NEW.previous_projection_fingerprint
  ))
  OR json_type(NEW.next_projection_json, '$') IS NOT 'object'
  OR (SELECT COUNT(*) FROM json_each(NEW.next_projection_json)) != 6
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.next_projection_json)
    WHERE key NOT IN ('schema', 'id', 'canonicalEmail', 'fullName', 'organization', 'title')
  )
  OR json_extract(NEW.next_projection_json, '$.schema') IS NOT 'connector-person-projection/v1'
  OR json_type(NEW.next_projection_json, '$.id') IS NOT 'text'
  OR json_type(NEW.next_projection_json, '$.canonicalEmail') IS NOT 'text'
  OR json_type(NEW.next_projection_json, '$.fullName') IS NOT 'text'
  OR json_type(NEW.next_projection_json, '$.organization') NOT IN ('text', 'null')
  OR json_type(NEW.next_projection_json, '$.title') NOT IN ('text', 'null')
  OR (NEW.previous_projection_json IS NOT NULL AND (
    json_type(NEW.previous_projection_json, '$') IS NOT 'object'
    OR (SELECT COUNT(*) FROM json_each(NEW.previous_projection_json)) != 6
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.previous_projection_json)
      WHERE key NOT IN ('schema', 'id', 'canonicalEmail', 'fullName', 'organization', 'title')
    )
    OR json_extract(NEW.previous_projection_json, '$.schema') IS NOT 'connector-person-projection/v1'
    OR json_type(NEW.previous_projection_json, '$.id') IS NOT 'text'
    OR json_type(NEW.previous_projection_json, '$.canonicalEmail') IS NOT 'text'
    OR json_type(NEW.previous_projection_json, '$.fullName') IS NOT 'text'
    OR json_type(NEW.previous_projection_json, '$.organization') NOT IN ('text', 'null')
    OR json_type(NEW.previous_projection_json, '$.title') NOT IN ('text', 'null')
  ))
  OR NOT EXISTS (
  SELECT 1
  FROM people person
  JOIN source_records source
    ON source.id = NEW.source_record_id AND source.workspace_id = NEW.workspace_id
  JOIN source_links source_link
    ON source_link.source_record_id = source.id
       AND source_link.person_id = person.id
       AND source_link.workspace_id = NEW.workspace_id
  JOIN connector_runs run
    ON run.id = NEW.import_run_id
       AND run.workspace_id = NEW.workspace_id
       AND run.operation = 'IMPORT'
       AND run.state = 'PREVIEW_READY'
       AND run.created_by_account_id = NEW.confirmed_by_account_id
  JOIN connector_import_preview_rows preview
    ON preview.id = NEW.preview_row_id
       AND preview.workspace_id = NEW.workspace_id
       AND preview.run_id = run.id
       AND preview.applied_source_record_id = source.id
  JOIN accounts actor
    ON actor.id = NEW.confirmed_by_account_id AND actor.workspace_id = NEW.workspace_id
  WHERE person.id = NEW.person_id AND person.workspace_id = NEW.workspace_id
    AND json_extract(NEW.next_projection_json, '$.id') = person.id
    AND json_extract(NEW.next_projection_json, '$.canonicalEmail') = person.canonical_email
    AND json_extract(NEW.next_projection_json, '$.fullName') = person.full_name
    AND json_extract(NEW.next_projection_json, '$.organization') IS person.organization
    AND json_extract(NEW.next_projection_json, '$.title') IS person.title
    AND source.provider = 'connector.' || run.provider
    AND source.source_ref = run.connection_id || ':' || preview.provider_record_id
    AND (
      (NEW.decision_kind = 'CREATE_FROM_SOURCE'
        AND preview.disposition = 'CREATE'
        AND preview.candidate_person_id IS NULL
        AND json_extract(NEW.next_projection_json, '$.canonicalEmail') = preview.normalized_email
        AND json_extract(NEW.next_projection_json, '$.fullName') = preview.full_name
        AND json_extract(NEW.next_projection_json, '$.organization') IS preview.organization
        AND json_extract(NEW.next_projection_json, '$.title') IS preview.title)
      OR
      (NEW.decision_kind = 'UPDATE_FROM_SOURCE'
        AND preview.disposition = 'UPDATE'
        AND preview.candidate_person_id = person.id
        AND json_extract(NEW.next_projection_json, '$.canonicalEmail') = preview.normalized_email
        AND json_extract(NEW.next_projection_json, '$.fullName') = preview.full_name
        AND json_extract(NEW.next_projection_json, '$.organization') IS
          COALESCE(preview.organization, json_extract(NEW.previous_projection_json, '$.organization'))
        AND json_extract(NEW.next_projection_json, '$.title') IS
          COALESCE(preview.title, json_extract(NEW.previous_projection_json, '$.title')))
    )
    AND (
      NEW.decision_kind = 'CREATE_FROM_SOURCE'
      OR (
        json_extract(NEW.previous_projection_json, '$.id') = person.id
        AND preview.candidate_person_fingerprint = sympose_pd01_fingerprint(json_object(
          'schema', 'connector-person-preview/v1',
          'id', json_extract(NEW.previous_projection_json, '$.id'),
          'canonicalEmail', json_extract(NEW.previous_projection_json, '$.canonicalEmail'),
          'fullName', json_extract(NEW.previous_projection_json, '$.fullName'),
          'organization', json_extract(NEW.previous_projection_json, '$.organization'),
          'title', json_extract(NEW.previous_projection_json, '$.title')
        ))
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'person projection decision scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_person_projection_decisions_immutable
BEFORE UPDATE ON person_projection_decisions
BEGIN SELECT RAISE(ABORT, 'person projection decision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_person_projection_decisions_no_delete
BEFORE DELETE ON person_projection_decisions
BEGIN SELECT RAISE(ABORT, 'person projection decision is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_import_success_integrity
BEFORE UPDATE OF state ON connector_runs
WHEN NEW.operation = 'IMPORT' AND NEW.state = 'SUCCEEDED' AND (
  OLD.state != 'PREVIEW_READY'
  OR NEW.confirmation_token_hash IS NOT NULL
  OR NEW.confirmation_expires_at IS NOT NULL
  OR NEW.confirmed_at IS NULL
  OR NEW.confirmed_by_account_id IS NULL
  OR NEW.completed_at IS NULL
  OR EXISTS (
    SELECT 1
    FROM connector_import_preview_rows preview
    WHERE preview.workspace_id = NEW.workspace_id AND preview.run_id = NEW.id
      AND (
        preview.disposition = 'EVALUATING'
        OR (preview.disposition IN ('CREATE', 'UPDATE', 'LINK') AND preview.applied_source_record_id IS NULL)
        OR (preview.disposition = 'CONFLICT' AND preview.applied_source_record_id IS NOT NULL)
        OR (preview.disposition IN ('CREATE', 'UPDATE') AND (
          SELECT COUNT(*) FROM person_projection_decisions decision
          WHERE decision.workspace_id = preview.workspace_id
            AND decision.import_run_id = preview.run_id
            AND decision.preview_row_id = preview.id
            AND decision.source_record_id = preview.applied_source_record_id
            AND decision.confirmed_by_account_id = NEW.confirmed_by_account_id
        ) != 1)
        OR (preview.disposition IN ('LINK', 'CONFLICT') AND EXISTS (
          SELECT 1 FROM person_projection_decisions decision
          WHERE decision.workspace_id = preview.workspace_id
            AND decision.import_run_id = preview.run_id
            AND decision.preview_row_id = preview.id
        ))
      )
  )
  OR EXISTS (
    SELECT 1 FROM person_projection_decisions decision
    WHERE decision.workspace_id = NEW.workspace_id AND decision.import_run_id = NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM connector_import_preview_rows preview
        WHERE preview.workspace_id = decision.workspace_id
          AND preview.run_id = decision.import_run_id
          AND preview.id = decision.preview_row_id
          AND preview.disposition IN ('CREATE', 'UPDATE')
          AND preview.applied_source_record_id = decision.source_record_id
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'connector import confirmation evidence incomplete'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_export_authority_scope_guard
BEFORE INSERT ON connector_export_authority_versions
WHEN sympose_pd01_canonical_json(NEW.purpose_evidence_json) IS NOT NEW.purpose_evidence_json
  OR sympose_pd01_fingerprint(NEW.purpose_evidence_json) IS NOT NEW.purpose_evidence_fingerprint
  OR sympose_pd01_canonical_json(NEW.retention_evidence_json) IS NOT NEW.retention_evidence_json
  OR sympose_pd01_fingerprint(NEW.retention_evidence_json) IS NOT NEW.retention_evidence_fingerprint
  OR sympose_pd01_canonical_json(NEW.authority_evidence_json) IS NOT NEW.authority_evidence_json
  OR sympose_pd01_fingerprint(NEW.authority_evidence_json) IS NOT NEW.authority_evidence_fingerprint
  OR json_extract(NEW.purpose_evidence_json, '$.schema') IS NOT 'authority-purpose-evidence/v1'
  OR json_extract(NEW.retention_evidence_json, '$.schema') IS NOT 'authority-retention-evidence/v1'
  OR json_extract(NEW.authority_evidence_json, '$.schema') IS NOT 'authority-version-evidence/v1'
  OR json_extract(NEW.purpose_evidence_json, '$.workspaceId') IS NOT NEW.workspace_id
  OR json_extract(NEW.retention_evidence_json, '$.workspaceId') IS NOT NEW.workspace_id
  OR json_extract(NEW.authority_evidence_json, '$.workspaceId') IS NOT NEW.workspace_id
  OR json_extract(NEW.purpose_evidence_json, '$.eventId') IS NOT NEW.event_id
  OR json_extract(NEW.retention_evidence_json, '$.eventId') IS NOT NEW.event_id
  OR json_extract(NEW.authority_evidence_json, '$.eventId') IS NOT NEW.event_id
  OR json_extract(NEW.purpose_evidence_json, '$.subject.kind') IS NOT 'PERSON'
  OR json_extract(NEW.retention_evidence_json, '$.subject.kind') IS NOT 'PERSON'
  OR json_extract(NEW.purpose_evidence_json, '$.subject.id') IS NOT NEW.person_id
  OR json_extract(NEW.retention_evidence_json, '$.subject.id') IS NOT NEW.person_id
  OR NOT EXISTS (
    SELECT 1 FROM connector_connections connection, people person, events event_row
    WHERE connection.id = NEW.connection_id
      AND connection.workspace_id = NEW.workspace_id AND connection.provider = NEW.provider
      AND person.id = NEW.person_id AND person.workspace_id = NEW.workspace_id
      AND event_row.id = NEW.event_id AND event_row.workspace_id = NEW.workspace_id
  )
  OR NEW.version IS NOT COALESCE((
    SELECT MAX(prior.version) + 1 FROM connector_export_authority_versions prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.connection_id = NEW.connection_id AND prior.person_id = NEW.person_id
  ), 1)
  OR EXISTS (
    SELECT 1 FROM connector_export_authority_versions prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.connection_id = NEW.connection_id AND prior.person_id = NEW.person_id
      AND prior.version = NEW.version - 1 AND NEW.recorded_at < prior.recorded_at
  )
BEGIN SELECT RAISE(ABORT, 'connector export authority evidence mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_export_authority_immutable
BEFORE UPDATE ON connector_export_authority_versions
BEGIN SELECT RAISE(ABORT, 'connector export authority evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_export_authority_no_delete
BEFORE DELETE ON connector_export_authority_versions
BEGIN SELECT RAISE(ABORT, 'connector export authority evidence is retained'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_export_manifest_scope_guard
BEFORE INSERT ON connector_export_manifests
WHEN sympose_pd01_canonical_json(NEW.candidates_json) IS NOT NEW.candidates_json
  OR sympose_pd01_fingerprint(NEW.candidates_json) IS NOT NEW.candidates_fingerprint
  OR json_type(NEW.candidates_json, '$') IS NOT 'array'
  OR json_array_length(NEW.candidates_json) IS NOT NEW.candidate_count
  OR NOT EXISTS (
    SELECT 1 FROM connector_runs run
    WHERE run.id = NEW.run_id AND run.workspace_id = NEW.workspace_id
      AND run.connection_id = NEW.connection_id AND run.connection_version = NEW.connection_version
      AND run.provider = NEW.provider AND run.operation = 'EXPORT' AND run.state = 'CREATED'
      AND run.input_fingerprint = sympose_pd01_fingerprint(json_object(
        'schema', 'connector-export/v1',
        'provider', NEW.provider,
        'connectionId', NEW.connection_id,
        'connectionVersion', NEW.connection_version,
        'totalCount', NEW.total_person_count,
        'candidates', json(NEW.candidates_json)
      ))
  )
BEGIN SELECT RAISE(ABORT, 'connector export manifest mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_export_manifest_immutable
BEFORE UPDATE ON connector_export_manifests
BEGIN SELECT RAISE(ABORT, 'connector export manifest is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_export_manifest_no_delete
BEFORE DELETE ON connector_export_manifests
BEGIN SELECT RAISE(ABORT, 'connector export manifest is retained'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_export_decision_scope_guard
BEFORE INSERT ON connector_export_decisions
WHEN sympose_pd01_canonical_json(NEW.projection_json) IS NOT NEW.projection_json
  OR sympose_pd01_fingerprint(NEW.projection_json) IS NOT NEW.projection_fingerprint
  OR sympose_pd01_canonical_json(NEW.fact_families_json) IS NOT NEW.fact_families_json
  OR sympose_pd01_fingerprint(NEW.fact_families_json) IS NOT NEW.fact_families_fingerprint
  OR sympose_pd01_canonical_json(NEW.preflight_input_json) IS NOT NEW.preflight_input_json
  OR sympose_pd01_fingerprint(NEW.preflight_input_json) IS NOT NEW.preflight_input_fingerprint
  OR sympose_pd01_canonical_json(NEW.preflight_result_json) IS NOT NEW.preflight_result_json
  OR sympose_pd01_fingerprint(NEW.preflight_result_json) IS NOT NEW.preflight_result_fingerprint
  OR json_extract(NEW.preflight_input_json, '$.command.workspaceId') IS NOT NEW.workspace_id
  OR json_extract(NEW.preflight_input_json, '$.command.subject.kind') IS NOT 'PERSON'
  OR json_extract(NEW.preflight_input_json, '$.command.subject.id') IS NOT NEW.person_id
  OR json_extract(NEW.preflight_input_json, '$.command.actionFamily') IS NOT NEW.action_family
  OR sympose_pd01_canonical_json(
    json_extract(NEW.preflight_input_json, '$.command.factFamilies')
  ) IS NOT NEW.fact_families_json
  OR json_extract(NEW.preflight_result_json, '$.schema') IS NOT 'authority-purpose-preflight/v1'
  OR json_extract(NEW.preflight_result_json, '$.state') IS NOT NEW.decision_state
  OR json_extract(NEW.preflight_result_json, '$.checkedAt') IS NOT
    json_extract(NEW.preflight_input_json, '$.now')
  OR (NEW.decision_state = 'READY' AND (
    NEW.authority_version_id IS NULL
    OR json_array_length(NEW.preflight_result_json, '$.receipts') != 0
  ))
  OR (NEW.decision_state != 'READY' AND json_array_length(NEW.preflight_result_json, '$.receipts') = 0)
  OR NOT EXISTS (
    SELECT 1 FROM connector_runs run, connector_connections connection, people person
    WHERE run.id = NEW.run_id AND run.workspace_id = NEW.workspace_id
      AND run.operation = 'EXPORT' AND run.provider = NEW.provider
      AND run.connection_id = NEW.connection_id
      AND run.connection_version = NEW.connection_version
      AND run.state = 'CREATED'
      AND connection.id = NEW.connection_id AND connection.workspace_id = NEW.workspace_id
      AND connection.provider = NEW.provider
      AND person.id = NEW.person_id AND person.workspace_id = NEW.workspace_id
  )
  OR (NEW.authority_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM connector_export_authority_versions authority
    WHERE authority.id = NEW.authority_version_id
      AND authority.workspace_id = NEW.workspace_id
      AND authority.connection_id = NEW.connection_id
      AND authority.provider = NEW.provider
      AND authority.person_id = NEW.person_id
  ))
  OR NOT EXISTS (
    SELECT 1
    FROM connector_export_manifests manifest, json_each(manifest.candidates_json) candidate
    WHERE manifest.run_id = NEW.run_id AND manifest.workspace_id = NEW.workspace_id
      AND manifest.connection_id = NEW.connection_id
      AND manifest.connection_version = NEW.connection_version
      AND manifest.provider = NEW.provider
      AND json_extract(candidate.value, '$.person.personId') = NEW.person_id
      AND sympose_pd01_fingerprint(json_extract(candidate.value, '$.person')) = NEW.projection_fingerprint
      AND (
        (NEW.authority_version_id IS NULL
          AND json_extract(candidate.value, '$.authority.state') = 'ABSENT')
        OR
        (NEW.authority_version_id IS NOT NULL
          AND json_extract(candidate.value, '$.authority.state') = 'PRESENT'
          AND json_extract(candidate.value, '$.authority.id') = NEW.authority_version_id)
      )
  )
BEGIN SELECT RAISE(ABORT, 'connector export purpose decision mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_export_decision_immutable
BEFORE UPDATE ON connector_export_decisions
BEGIN SELECT RAISE(ABORT, 'connector export purpose decision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_export_decision_no_delete
BEFORE DELETE ON connector_export_decisions
BEGIN SELECT RAISE(ABORT, 'connector export purpose decision is retained'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_export_scope_guard BEFORE INSERT ON connector_export_receipts
WHEN NOT EXISTS (SELECT 1 FROM connector_runs r WHERE r.id = NEW.run_id AND r.workspace_id = NEW.workspace_id AND r.operation = 'EXPORT')
  OR NOT EXISTS (SELECT 1 FROM people p WHERE p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id)
  OR NOT EXISTS (
    SELECT 1 FROM connector_export_decisions decision
    WHERE decision.workspace_id = NEW.workspace_id AND decision.run_id = NEW.run_id
      AND decision.person_id = NEW.person_id AND decision.decision_state = 'READY'
      AND decision.projection_fingerprint = NEW.input_fingerprint
  )
BEGIN SELECT RAISE(ABORT, 'connector export receipt scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_export_immutable BEFORE UPDATE ON connector_export_receipts
BEGIN SELECT RAISE(ABORT, 'connector export receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_connector_export_no_delete BEFORE DELETE ON connector_export_receipts
BEGIN SELECT RAISE(ABORT, 'connector export receipt is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_export_success_integrity
BEFORE UPDATE OF state ON connector_runs
WHEN NEW.operation = 'EXPORT' AND NEW.state = 'SUCCEEDED' AND (
  OLD.state != 'RUNNING'
  OR NEW.completed_at IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM connector_export_manifests manifest
    WHERE manifest.workspace_id = NEW.workspace_id AND manifest.run_id = NEW.id
  )
  OR EXISTS (
    SELECT 1 FROM connector_export_decisions decision
    WHERE decision.workspace_id = NEW.workspace_id AND decision.run_id = NEW.id
      AND decision.decision_state != 'READY'
  )
  OR (SELECT COUNT(*) FROM connector_export_receipts receipt
      WHERE receipt.workspace_id = NEW.workspace_id AND receipt.run_id = NEW.id)
     !=
     (SELECT COUNT(*) FROM connector_export_decisions decision
      WHERE decision.workspace_id = NEW.workspace_id AND decision.run_id = NEW.id)
  OR (SELECT COUNT(*) FROM connector_export_decisions decision
      WHERE decision.workspace_id = NEW.workspace_id AND decision.run_id = NEW.id)
     !=
     (SELECT manifest.candidate_count FROM connector_export_manifests manifest
      WHERE manifest.workspace_id = NEW.workspace_id AND manifest.run_id = NEW.id)
  OR NEW.item_count != (
    SELECT COUNT(*) FROM connector_export_receipts receipt
    WHERE receipt.workspace_id = NEW.workspace_id AND receipt.run_id = NEW.id
  )
)
BEGIN SELECT RAISE(ABORT, 'connector export authorization evidence incomplete'); END;

CREATE TRIGGER IF NOT EXISTS trg_connector_export_denial_integrity
BEFORE UPDATE OF state ON connector_runs
WHEN NEW.operation = 'EXPORT' AND NEW.state = 'FAILED_TERMINAL'
  AND NEW.error_code = 'EXPORT_PURPOSE_AUTHORIZATION_DENIED' AND (
    NOT EXISTS (
      SELECT 1 FROM connector_export_manifests manifest
      WHERE manifest.workspace_id = NEW.workspace_id AND manifest.run_id = NEW.id
    )
    OR (SELECT COUNT(*) FROM connector_export_decisions decision
        WHERE decision.workspace_id = NEW.workspace_id AND decision.run_id = NEW.id)
       !=
       (SELECT manifest.candidate_count FROM connector_export_manifests manifest
        WHERE manifest.workspace_id = NEW.workspace_id AND manifest.run_id = NEW.id)
    OR NOT EXISTS (
      SELECT 1 FROM connector_export_decisions decision
      WHERE decision.workspace_id = NEW.workspace_id AND decision.run_id = NEW.id
        AND decision.decision_state IN ('BLOCKED', 'UNAVAILABLE')
    )
  )
BEGIN SELECT RAISE(ABORT, 'connector export denial evidence incomplete'); END;
`;

// Keep the accepted V4-V6 table definition literal. Fresh V7 databases substitute only the
// versioned table definition below, while upgrades add the same column through ALTER TABLE.
// SQLite preserves this exact column fragment in sqlite_schema, so fresh and migrated V7
// databases converge on one physical manifest without rewriting the historical packets.
const V6_CFP_EMAIL_VERIFICATIONS_TABLE = `CREATE TABLE IF NOT EXISTS cfp_email_verifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL CHECK (length(token_hash) BETWEEN 1 AND 128),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, call_id, email, token_hash)
)`;

export const V7_VERIFICATION_ISSUANCE_SEQUENCE_COLUMN =
  "issuance_sequence INTEGER NOT NULL DEFAULT 1 CHECK (typeof(issuance_sequence) = 'integer' AND issuance_sequence BETWEEN 1 AND 9007199254740991)";

const V7_CFP_EMAIL_VERIFICATIONS_TABLE = `CREATE TABLE IF NOT EXISTS cfp_email_verifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL CHECK (length(token_hash) BETWEEN 1 AND 128),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL, ${V7_VERIFICATION_ISSUANCE_SEQUENCE_COLUMN},
  UNIQUE (workspace_id, call_id, email, token_hash)
)`;

export const V4_DDL = `
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

-- Evidence: immutable source payloads from an external provider/system.
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

-- Canonical person root; the durable identity spine inside a workspace.
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

-- Reversible mapping from evidence to the canonical person.
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

-- Immutable materialization of one definition version.
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

-- Immutable plan content; lifecycle lives in plan_states and approvals.
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

-- Append-only plan lifecycle transitions (candidate -> approved, etc.).
CREATE TABLE IF NOT EXISTS plan_states (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id),
  state TEXT NOT NULL,
  actor_account_id TEXT REFERENCES accounts(id),
  reason TEXT,
  created_at TEXT NOT NULL
);

-- Typed plan assignments with stable lineage; one typed subtype per row.
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

-- Decision truth: organizer approval records. Append-only.
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

-- Exact immutable offer terms for one person.
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

-- One simulated participant response per offer; append-only.
CREATE TABLE IF NOT EXISTS commitment_responses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  offer_id TEXT NOT NULL REFERENCES commitment_offers(id),
  response TEXT NOT NULL,
  responded_at TEXT NOT NULL,
  actor_person_id TEXT NOT NULL REFERENCES people(id),
  UNIQUE (workspace_id, offer_id)
);

-- Sealed audience release. Immutable; future supersession must use separate,
-- append-only lineage rather than mutating a release row.
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

-- Only the hash of the opaque portal token is stored.
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

-- Operational truth: what actually happened. Append-only; corrections link.
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

-- CFP publication roots and sealed evaluator artifacts.
CREATE TABLE IF NOT EXISTS form_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  form_definition_id TEXT NOT NULL REFERENCES form_definitions(id),
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  rules_schema TEXT NOT NULL CHECK (rules_schema = 'cfp-form-rules/v1'),
  rules_json TEXT NOT NULL,
  fingerprint_algorithm TEXT NOT NULL CHECK (fingerprint_algorithm = 'sha256-canonical-json-v1'),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  sealed_by TEXT NOT NULL REFERENCES accounts(id),
  sealed_at TEXT NOT NULL CHECK (length(sealed_at) > 0),
  UNIQUE (form_definition_id, version_number),
  UNIQUE (workspace_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS form_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  form_definition_id TEXT NOT NULL REFERENCES form_definitions(id),
  rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  document_schema TEXT NOT NULL CHECK (document_schema = 'cfp-form-document/v1'),
  document_json TEXT NOT NULL,
  fingerprint_algorithm TEXT NOT NULL CHECK (fingerprint_algorithm = 'sha256-canonical-json-v1'),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  sealed_by TEXT NOT NULL REFERENCES accounts(id),
  sealed_at TEXT NOT NULL CHECK (length(sealed_at) > 0),
  UNIQUE (form_definition_id, version_number),
  UNIQUE (workspace_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  form_version_id TEXT NOT NULL REFERENCES form_versions(id),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('PUBLIC', 'INVITED', 'PUBLIC_AND_INVITED')),
  state TEXT NOT NULL CHECK (state IN ('DRAFT', 'SCHEDULED', 'OPEN', 'PAUSED', 'CLOSED', 'ARCHIVED', 'CANCELLED')),
  timezone TEXT NOT NULL,
  opens_at TEXT,
  closes_at TEXT,
  policy_version_id TEXT NOT NULL,
  policy_schema TEXT NOT NULL CHECK (policy_schema = 'cfp-call-policy/v1'),
  policy_json TEXT NOT NULL,
   policy_fingerprint_algorithm TEXT NOT NULL CHECK (policy_fingerprint_algorithm = 'sha256-canonical-json-v1'),
   policy_fingerprint TEXT NOT NULL CHECK (length(policy_fingerprint) = 64),
   created_at TEXT NOT NULL,
   updated_at TEXT NOT NULL CHECK (updated_at >= created_at),
   UNIQUE (workspace_id, event_id, slug)
 );

CREATE TABLE IF NOT EXISTS call_extensions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  extends_to TEXT NOT NULL,
  reason TEXT NOT NULL,
  granted_by TEXT NOT NULL REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);

${V6_CFP_EMAIL_VERIFICATIONS_TABLE};

CREATE TABLE IF NOT EXISTS cfp_email_verification_consumptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  verification_id TEXT NOT NULL REFERENCES cfp_email_verifications(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  consumed_at TEXT NOT NULL,
  UNIQUE (workspace_id, verification_id)
);

CREATE TABLE IF NOT EXISTS cfp_applicant_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  verification_id TEXT NOT NULL REFERENCES cfp_email_verifications(id),
   token_hash TEXT NOT NULL CHECK (length(token_hash) BETWEEN 1 AND 128),
   created_at TEXT NOT NULL,
   expires_at TEXT NOT NULL CHECK (expires_at > created_at),
   revoked_at TEXT,
   revoked_by TEXT REFERENCES accounts(id),
   revoked_reason TEXT,
   CHECK (
     (revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL)
     OR (
       revoked_at IS NOT NULL
       AND revoked_by IS NOT NULL
       AND revoked_reason IS NOT NULL
       AND length(revoked_at) > 0
       AND length(revoked_reason) > 0
     )
   ),
   UNIQUE (workspace_id, verification_id)
 );

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  owner_person_id TEXT NOT NULL REFERENCES people(id),
  state TEXT NOT NULL CHECK (state IN ('DRAFT', 'SUBMITTED', 'WITHDRAWN', 'INVALIDATED')),
  pinned_form_version_id TEXT NOT NULL REFERENCES form_versions(id),
   pinned_rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
   current_revision_id TEXT REFERENCES submission_revisions(id),
   created_at TEXT NOT NULL,
   updated_at TEXT NOT NULL CHECK (updated_at >= created_at)
 );

CREATE TABLE IF NOT EXISTS submission_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  revision_schema TEXT NOT NULL CHECK (revision_schema = 'cfp-submission-revision/v1'),
  revision_json TEXT NOT NULL,
  form_version_id TEXT NOT NULL REFERENCES form_versions(id),
  rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
  form_document_schema TEXT NOT NULL CHECK (form_document_schema = 'cfp-form-document/v1'),
  form_document_fingerprint TEXT NOT NULL CHECK (length(form_document_fingerprint) = 64),
  policy_schema TEXT NOT NULL CHECK (policy_schema = 'cfp-call-policy/v1'),
  policy_version_id TEXT NOT NULL,
  policy_fingerprint_algorithm TEXT NOT NULL CHECK (policy_fingerprint_algorithm = 'sha256-canonical-json-v1'),
  policy_fingerprint TEXT NOT NULL CHECK (length(policy_fingerprint) = 64),
  consent_receipt_schema TEXT,
  consent_receipt_policy_fingerprint TEXT,
  session_id TEXT NOT NULL REFERENCES cfp_applicant_sessions(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  fingerprint_algorithm TEXT NOT NULL CHECK (fingerprint_algorithm = 'sha256-canonical-json-v1'),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_at TEXT NOT NULL,
   CHECK (
     (consent_receipt_schema IS NULL AND consent_receipt_policy_fingerprint IS NULL)
     OR (
       consent_receipt_schema IS NOT NULL
       AND consent_receipt_policy_fingerprint IS NOT NULL
       AND consent_receipt_schema = 'cfp-consent-receipt/v1'
       AND length(consent_receipt_policy_fingerprint) = 64
     )
  ),
  UNIQUE (workspace_id, submission_id, revision_number),
   UNIQUE (workspace_id, fingerprint)
 );

CREATE INDEX IF NOT EXISTS idx_cfp_form_definitions_workspace ON form_definitions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_cfp_rule_versions_definition ON rule_versions(workspace_id, form_definition_id, version_number);
CREATE INDEX IF NOT EXISTS idx_cfp_form_versions_definition ON form_versions(workspace_id, form_definition_id, version_number);
CREATE INDEX IF NOT EXISTS idx_cfp_form_versions_rule ON form_versions(workspace_id, rule_version_id);
CREATE INDEX IF NOT EXISTS idx_cfp_calls_event_state ON calls(workspace_id, event_id, state);
CREATE INDEX IF NOT EXISTS idx_cfp_call_extensions_call_person ON call_extensions(workspace_id, call_id, person_id);
CREATE INDEX IF NOT EXISTS idx_cfp_email_verifications_call_expiry ON cfp_email_verifications(workspace_id, call_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_cfp_email_verification_consumptions_person ON cfp_email_verification_consumptions(workspace_id, person_id, verification_id);
CREATE INDEX IF NOT EXISTS idx_cfp_applicant_sessions_call_person ON cfp_applicant_sessions(workspace_id, call_id, person_id);
CREATE INDEX IF NOT EXISTS idx_cfp_submissions_event_state ON submissions(workspace_id, event_id, state);
CREATE INDEX IF NOT EXISTS idx_cfp_submissions_call_state ON submissions(workspace_id, call_id, state);
CREATE INDEX IF NOT EXISTS idx_cfp_submissions_owner_state ON submissions(workspace_id, owner_person_id, state);
CREATE INDEX IF NOT EXISTS idx_cfp_submission_revisions_submission ON submission_revisions(workspace_id, submission_id, revision_number);

-- Tenant-reference guards: duplicated workspace_id columns are an authorization invariant,
-- not decorative metadata. These checks keep every relationship inside one workspace even
-- if a future service accidentally omits a join predicate.
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

-- Immutable tables must reject UPDATE/DELETE at the database boundary.
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

-- CFP tenant and artifact guards. These are intentionally database-boundary checks;
-- service reads repeat the same relationships before trusting stored evidence.
CREATE TRIGGER IF NOT EXISTS trg_cfp_rule_versions_workspace_guard BEFORE INSERT ON rule_versions
WHEN NOT EXISTS (
  SELECT 1 FROM form_definitions d, accounts a
  WHERE d.id = NEW.form_definition_id AND d.workspace_id = NEW.workspace_id
    AND a.id = NEW.sealed_by AND a.workspace_id = NEW.workspace_id
)
OR NEW.rules_schema != 'cfp-form-rules/v1'
OR NEW.fingerprint_algorithm != 'sha256-canonical-json-v1'
OR length(NEW.sealed_at) = 0
BEGIN SELECT RAISE(ABORT, 'rule_versions workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_form_versions_workspace_guard BEFORE INSERT ON form_versions
WHEN NOT EXISTS (
  SELECT 1
  FROM form_definitions d, rule_versions r, accounts a
  WHERE d.id = NEW.form_definition_id AND d.workspace_id = NEW.workspace_id
    AND r.id = NEW.rule_version_id AND r.workspace_id = NEW.workspace_id
    AND r.form_definition_id = d.id
    AND r.version_number = NEW.version_number
    AND a.id = NEW.sealed_by AND a.workspace_id = NEW.workspace_id
    AND length(r.sealed_at) > 0
)
OR NEW.document_schema != 'cfp-form-document/v1'
OR NEW.fingerprint_algorithm != 'sha256-canonical-json-v1'
OR length(NEW.sealed_at) = 0
BEGIN SELECT RAISE(ABORT, 'form_versions workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_calls_workspace_guard BEFORE INSERT ON calls
WHEN NOT EXISTS (
  SELECT 1
  FROM events e, form_versions f
  WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
    AND f.id = NEW.form_version_id AND f.workspace_id = NEW.workspace_id
    AND length(f.sealed_at) > 0
    AND EXISTS (
      SELECT 1 FROM rule_versions r
      WHERE r.id = f.rule_version_id
        AND r.form_definition_id = f.form_definition_id
        AND r.version_number = f.version_number
    )
)
OR NEW.policy_schema != 'cfp-call-policy/v1'
OR NEW.policy_fingerprint_algorithm != 'sha256-canonical-json-v1'
OR length(NEW.policy_fingerprint) != 64
OR json_valid(NEW.policy_json) != 1
OR (
  json_valid(NEW.policy_json) = 1
  AND (
    json_extract(NEW.policy_json, '$.schema') IS NOT NEW.policy_schema
    OR json_extract(NEW.policy_json, '$.policyVersionId') IS NOT NEW.policy_version_id
  )
)
BEGIN SELECT RAISE(ABORT, 'calls workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_calls_workspace_update_guard BEFORE UPDATE ON calls
WHEN NEW.id != OLD.id
  OR NEW.workspace_id != OLD.workspace_id
   OR NEW.event_id != OLD.event_id
   OR NEW.created_at != OLD.created_at
   OR NEW.updated_at < OLD.updated_at
   OR NEW.updated_at < NEW.created_at
   OR NOT EXISTS (
     SELECT 1
     FROM events e, form_versions new_form
     WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
       AND new_form.id = NEW.form_version_id AND new_form.workspace_id = NEW.workspace_id
       AND length(new_form.sealed_at) > 0
       AND EXISTS (
         SELECT 1 FROM rule_versions new_rule
         WHERE new_rule.id = new_form.rule_version_id
           AND new_rule.form_definition_id = new_form.form_definition_id
           AND new_rule.version_number = new_form.version_number
       )
       AND (
         NEW.form_version_id = OLD.form_version_id
         OR EXISTS (
           SELECT 1
           FROM form_versions old_form, rule_versions old_rule
           WHERE old_form.id = OLD.form_version_id
             AND old_form.workspace_id = NEW.workspace_id
             AND old_rule.id = old_form.rule_version_id
             AND old_rule.form_definition_id = old_form.form_definition_id
             AND old_rule.version_number = old_form.version_number
             AND old_form.form_definition_id = new_form.form_definition_id
             AND new_form.version_number > old_form.version_number
         )
       )
   )
  OR NEW.policy_schema != 'cfp-call-policy/v1'
  OR NEW.policy_fingerprint_algorithm != 'sha256-canonical-json-v1'
  OR length(NEW.policy_fingerprint) != 64
  OR json_valid(NEW.policy_json) != 1
  OR (
    json_valid(NEW.policy_json) = 1
    AND (
      json_extract(NEW.policy_json, '$.schema') IS NOT NEW.policy_schema
      OR json_extract(NEW.policy_json, '$.policyVersionId') IS NOT NEW.policy_version_id
    )
  )
BEGIN SELECT RAISE(ABORT, 'calls workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_call_extensions_workspace_guard BEFORE INSERT ON call_extensions
WHEN NOT EXISTS (
  SELECT 1 FROM calls c, people p, accounts a
  WHERE c.id = NEW.call_id AND c.workspace_id = NEW.workspace_id
    AND p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id
    AND a.id = NEW.granted_by AND a.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'call_extensions workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_email_verifications_workspace_guard BEFORE INSERT ON cfp_email_verifications
WHEN NOT EXISTS (
  SELECT 1 FROM calls c
  WHERE c.id = NEW.call_id AND c.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'cfp_email_verifications workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_email_verification_consumptions_workspace_guard BEFORE INSERT ON cfp_email_verification_consumptions
WHEN NOT EXISTS (
  SELECT 1
  FROM cfp_email_verifications v, people p
  WHERE v.id = NEW.verification_id AND v.workspace_id = NEW.workspace_id
    AND p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id
    AND lower(v.email) = lower(p.canonical_email)
)
BEGIN SELECT RAISE(ABORT, 'cfp_email_verification_consumptions workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_applicant_sessions_workspace_guard BEFORE INSERT ON cfp_applicant_sessions
WHEN NOT EXISTS (
  SELECT 1
  FROM calls c, people p, cfp_email_verifications v,
       cfp_email_verification_consumptions consumed
  WHERE c.id = NEW.call_id AND c.workspace_id = NEW.workspace_id
    AND p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id
    AND v.id = NEW.verification_id AND v.workspace_id = NEW.workspace_id
    AND v.call_id = NEW.call_id
    AND lower(v.email) = lower(p.canonical_email)
    AND consumed.workspace_id = NEW.workspace_id
    AND consumed.verification_id = NEW.verification_id
    AND consumed.person_id = NEW.person_id
)
OR (NEW.revoked_by IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM accounts a
   WHERE a.id = NEW.revoked_by AND a.workspace_id = NEW.workspace_id
 ))
OR (
  (NEW.revoked_at IS NULL AND (NEW.revoked_by IS NOT NULL OR NEW.revoked_reason IS NOT NULL))
  OR (NEW.revoked_at IS NOT NULL AND (
    NEW.revoked_by IS NULL OR NEW.revoked_reason IS NULL
    OR length(NEW.revoked_at) = 0 OR length(NEW.revoked_reason) = 0
  ))
)
BEGIN SELECT RAISE(ABORT, 'cfp_applicant_sessions workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_applicant_sessions_core_immutable BEFORE UPDATE ON cfp_applicant_sessions
WHEN NEW.id != OLD.id
  OR NEW.workspace_id != OLD.workspace_id
  OR NEW.call_id != OLD.call_id
  OR NEW.person_id != OLD.person_id
  OR NEW.verification_id != OLD.verification_id
  OR NEW.token_hash != OLD.token_hash
  OR NEW.created_at != OLD.created_at
  OR NEW.expires_at != OLD.expires_at
  OR OLD.revoked_at IS NOT NULL
   OR (NEW.revoked_by IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM accounts a
     WHERE a.id = NEW.revoked_by AND a.workspace_id = NEW.workspace_id
   ))
   OR (
     (NEW.revoked_at IS NULL AND (NEW.revoked_by IS NOT NULL OR NEW.revoked_reason IS NOT NULL))
     OR (NEW.revoked_at IS NOT NULL AND (
       NEW.revoked_by IS NULL OR NEW.revoked_reason IS NULL
       OR length(NEW.revoked_at) = 0 OR length(NEW.revoked_reason) = 0
     ))
   )
BEGIN SELECT RAISE(ABORT, 'cfp_applicant_sessions core fields are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_applicant_sessions_no_delete BEFORE DELETE ON cfp_applicant_sessions
BEGIN SELECT RAISE(ABORT, 'cfp_applicant_sessions is retained for audit'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_submissions_draft_only BEFORE INSERT ON submissions
WHEN NEW.state != 'DRAFT' OR NEW.current_revision_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'submissions must start as draft'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_submissions_workspace_guard BEFORE INSERT ON submissions
WHEN NOT EXISTS (
  SELECT 1
  FROM events e, calls c, people p, form_versions f, rule_versions r
  WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
    AND c.id = NEW.call_id AND c.workspace_id = NEW.workspace_id AND c.event_id = NEW.event_id
    AND p.id = NEW.owner_person_id AND p.workspace_id = NEW.workspace_id
    AND f.id = NEW.pinned_form_version_id AND f.workspace_id = NEW.workspace_id
    AND r.id = NEW.pinned_rule_version_id AND r.workspace_id = NEW.workspace_id
    AND c.form_version_id = f.id
    AND f.form_definition_id = r.form_definition_id
    AND f.rule_version_id = r.id
    AND f.version_number = r.version_number
    AND length(f.sealed_at) > 0
    AND length(r.sealed_at) > 0
)
BEGIN SELECT RAISE(ABORT, 'submissions workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_submissions_workspace_update_guard BEFORE UPDATE ON submissions
WHEN NEW.id != OLD.id
  OR NEW.workspace_id != OLD.workspace_id
  OR NEW.event_id != OLD.event_id
  OR NEW.call_id != OLD.call_id
  OR NEW.owner_person_id != OLD.owner_person_id
   OR NEW.pinned_form_version_id != OLD.pinned_form_version_id
   OR NEW.pinned_rule_version_id != OLD.pinned_rule_version_id
   OR NEW.created_at != OLD.created_at
   OR NEW.updated_at < OLD.updated_at
   OR NEW.updated_at < NEW.created_at
   OR (OLD.current_revision_id IS NOT NULL AND NEW.current_revision_id IS NULL)
   OR (NEW.current_revision_id IS NULL AND EXISTS (
     SELECT 1 FROM submission_revisions orphan
     WHERE orphan.workspace_id = NEW.workspace_id AND orphan.submission_id = NEW.id
   ))
   OR (NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
     SELECT 1
     FROM submission_revisions current_revision
     WHERE current_revision.id = NEW.current_revision_id
       AND current_revision.workspace_id = NEW.workspace_id
       AND current_revision.submission_id = NEW.id
       AND current_revision.form_version_id = NEW.pinned_form_version_id
       AND current_revision.rule_version_id = NEW.pinned_rule_version_id
       AND current_revision.revision_number = (
         SELECT MAX(all_revisions.revision_number)
         FROM submission_revisions all_revisions
         WHERE all_revisions.workspace_id = NEW.workspace_id
           AND all_revisions.submission_id = NEW.id
       )
       AND (
         SELECT COUNT(*)
         FROM submission_revisions all_revisions
         WHERE all_revisions.workspace_id = NEW.workspace_id
           AND all_revisions.submission_id = NEW.id
       ) = current_revision.revision_number
   ))
   OR (NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM submission_revisions r
    WHERE r.id = NEW.current_revision_id
      AND r.workspace_id = NEW.workspace_id
      AND r.submission_id = NEW.id
      AND r.form_version_id = NEW.pinned_form_version_id
      AND r.rule_version_id = NEW.pinned_rule_version_id
      AND r.revision_number = CASE
        WHEN OLD.current_revision_id IS NULL THEN 1
        WHEN NEW.current_revision_id = OLD.current_revision_id THEN
          (SELECT prior.revision_number
           FROM submission_revisions prior
           WHERE prior.id = OLD.current_revision_id)
        ELSE (SELECT prior.revision_number + 1
              FROM submission_revisions prior
              WHERE prior.id = OLD.current_revision_id)
      END
  ))
   OR (OLD.state IN ('SUBMITTED', 'WITHDRAWN', 'INVALIDATED') AND NEW.state != OLD.state)
  OR (NEW.state = 'SUBMITTED' AND OLD.state != 'SUBMITTED' AND NOT EXISTS (
    SELECT 1
    FROM submission_revisions r, calls c
    WHERE r.id = NEW.current_revision_id
      AND r.workspace_id = NEW.workspace_id
      AND r.submission_id = NEW.id
      AND c.id = NEW.call_id
      AND c.workspace_id = NEW.workspace_id
      AND r.revision_schema = 'cfp-submission-revision/v1'
       AND r.fingerprint_algorithm = 'sha256-canonical-json-v1'
       AND r.policy_schema = 'cfp-call-policy/v1'
       AND r.policy_fingerprint = c.policy_fingerprint
       AND r.policy_version_id = c.policy_version_id
        AND r.consent_receipt_schema = 'cfp-consent-receipt/v1'
        AND r.consent_receipt_policy_fingerprint = c.policy_fingerprint
        AND r.consent_receipt_policy_fingerprint = r.policy_fingerprint
       AND json_valid(r.revision_json) = 1
      AND json_type(r.revision_json, '$.consentReceipt') = 'object'
      AND json_extract(r.revision_json, '$.schema') = 'cfp-submission-revision/v1'
       AND json_extract(r.revision_json, '$.fingerprintAlgorithm') = 'sha256-canonical-json-v1'
       AND json_extract(r.revision_json, '$.callPolicy.schema') = c.policy_schema
       AND json_extract(r.revision_json, '$.callPolicy.policyVersionId') = c.policy_version_id
       AND json_extract(r.revision_json, '$.callPolicy.fingerprint') = c.policy_fingerprint
       AND json_extract(r.revision_json, '$.consentReceipt.schema') = 'cfp-consent-receipt/v1'
      AND json_extract(r.revision_json, '$.consentReceipt.submissionId') = NEW.id
       AND json_extract(r.revision_json, '$.consentReceipt.personId') = NEW.owner_person_id
        AND json_extract(r.revision_json, '$.consentReceipt.applicantSessionId') = r.session_id
       AND json_extract(r.revision_json, '$.consentReceipt.receivedAt') = r.created_at
        AND json_extract(r.revision_json, '$.consentReceipt.policyFingerprint') = c.policy_fingerprint
       AND EXISTS (
         SELECT 1
         FROM cfp_applicant_sessions session_row
         JOIN cfp_email_verification_consumptions consumed
           ON consumed.workspace_id = session_row.workspace_id
          AND consumed.verification_id = session_row.verification_id
          AND consumed.person_id = session_row.person_id
         WHERE session_row.id = r.session_id
           AND session_row.workspace_id = NEW.workspace_id
           AND session_row.call_id = NEW.call_id
           AND session_row.person_id = NEW.owner_person_id
           AND session_row.revoked_at IS NULL
       )
         AND json_type(c.policy_json, '$.choices') IS 'array'
         AND json_type(r.revision_json, '$.callPolicy.choices') IS 'array'
         AND json_type(r.revision_json, '$.consentReceipt.choices') IS 'array'
         AND NOT EXISTS (
           SELECT 1
           FROM json_each(c.policy_json, '$.choices') current_policy_choice
           WHERE current_policy_choice.type IS NOT 'object'
         )
         AND json_type(r.revision_json, '$.callPolicy') IS 'object'
        AND (SELECT COUNT(*) FROM json_each(r.revision_json, '$.callPolicy')) = 6
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(r.revision_json, '$.callPolicy') policy_key
          WHERE policy_key.key NOT IN (
            'schema', 'policyVersionId', 'disclosure', 'choices',
            'fingerprintAlgorithm', 'fingerprint'
          )
        )
        AND json_extract(r.revision_json, '$.callPolicy.schema') = c.policy_schema
        AND json_extract(r.revision_json, '$.callPolicy.policyVersionId') = c.policy_version_id
        AND json_extract(r.revision_json, '$.callPolicy.fingerprintAlgorithm') =
            'sha256-canonical-json-v1'
        AND json_extract(r.revision_json, '$.callPolicy.fingerprint') = c.policy_fingerprint
        AND json_type(r.revision_json, '$.consentReceipt') IS 'object'
        AND (SELECT COUNT(*) FROM json_each(r.revision_json, '$.consentReceipt')) = 7
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(r.revision_json, '$.consentReceipt') receipt_key
          WHERE receipt_key.key NOT IN (
            'schema', 'submissionId', 'personId', 'applicantSessionId',
            'receivedAt', 'policyFingerprint', 'choices'
          )
        )
        AND json_type(r.revision_json, '$.consentReceipt.schema') IS 'text'
        AND json_type(r.revision_json, '$.consentReceipt.submissionId') IS 'text'
        AND json_type(r.revision_json, '$.consentReceipt.personId') IS 'text'
        AND json_type(r.revision_json, '$.consentReceipt.applicantSessionId') IS 'text'
        AND json_type(r.revision_json, '$.consentReceipt.receivedAt') IS 'text'
        AND json_type(r.revision_json, '$.consentReceipt.policyFingerprint') IS 'text'
        AND json_array_length(r.revision_json, '$.callPolicy.choices') =
            json_array_length(c.policy_json, '$.choices')
        AND json_array_length(r.revision_json, '$.consentReceipt.choices') =
            json_array_length(c.policy_json, '$.choices')
       AND NOT EXISTS (
         SELECT 1
         FROM json_each(c.policy_json, '$.choices') current_choice
         WHERE NOT EXISTS (
           SELECT 1
            FROM json_each(r.revision_json, '$.callPolicy.choices') retained_choice
            WHERE retained_choice.key = current_choice.key
              AND current_choice.type = 'object'
              AND retained_choice.type = 'object'
              AND (SELECT COUNT(*) FROM json_each(retained_choice.value)) = 3
             AND NOT EXISTS (
               SELECT 1 FROM json_each(retained_choice.value) retained_key
               WHERE retained_key.key NOT IN ('fieldId', 'statement', 'required')
             )
             AND json_type(retained_choice.value, '$.fieldId') = 'text'
             AND json_type(retained_choice.value, '$.statement') = 'text'
              AND json_type(retained_choice.value, '$.required') IS NOT NULL
              AND json_type(retained_choice.value, '$.required') IN ('true', 'false')
             AND json_extract(retained_choice.value, '$.fieldId') =
                 json_extract(current_choice.value, '$.fieldId')
             AND json_extract(retained_choice.value, '$.statement') =
                 json_extract(current_choice.value, '$.statement')
             AND json_extract(retained_choice.value, '$.required') =
                 json_extract(current_choice.value, '$.required')
         )
       )
       AND NOT EXISTS (
         SELECT 1
            FROM json_each(c.policy_json, '$.choices') policy_choice
            WHERE NOT EXISTS (
              SELECT 1
              FROM json_each(r.revision_json, '$.consentReceipt.choices') receipt_choice
              WHERE receipt_choice.key = policy_choice.key
                AND policy_choice.type = 'object'
                AND receipt_choice.type = 'object'
               AND (SELECT COUNT(*) FROM json_each(receipt_choice.value)) = 2
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(receipt_choice.value) receipt_key
                 WHERE receipt_key.key NOT IN ('fieldId', 'value')
               )
               AND json_type(receipt_choice.value, '$.fieldId') = 'text'
               AND json_extract(receipt_choice.value, '$.fieldId') =
                   json_extract(policy_choice.value, '$.fieldId')
               AND json_type(receipt_choice.value, '$.value') IN ('true', 'false')
              AND (json_extract(policy_choice.value, '$.required') = 0
                   OR json_extract(receipt_choice.value, '$.value') = 1)
          )
      )
  ))
BEGIN SELECT RAISE(ABORT, 'submissions current pointer mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_submission_revisions_workspace_guard BEFORE INSERT ON submission_revisions
WHEN NOT EXISTS (
  SELECT 1
  FROM submissions s, form_versions f, rule_versions r,
       cfp_applicant_sessions session_row, calls c
  WHERE s.id = NEW.submission_id AND s.workspace_id = NEW.workspace_id
    AND s.state = 'DRAFT'
    AND f.id = NEW.form_version_id AND f.workspace_id = NEW.workspace_id
    AND r.id = NEW.rule_version_id AND r.workspace_id = NEW.workspace_id
    AND f.form_definition_id = r.form_definition_id
    AND f.rule_version_id = r.id
    AND s.pinned_form_version_id = f.id
    AND s.pinned_rule_version_id = r.id
    AND s.owner_person_id = NEW.person_id
    AND f.version_number = r.version_number
    AND c.id = s.call_id AND c.workspace_id = NEW.workspace_id
    AND session_row.id = NEW.session_id
    AND session_row.workspace_id = NEW.workspace_id
    AND session_row.call_id = c.id
    AND session_row.person_id = NEW.person_id
    AND session_row.revoked_at IS NULL
    AND NEW.created_at >= session_row.created_at
    AND NEW.created_at < session_row.expires_at
    AND EXISTS (
      SELECT 1
     FROM cfp_email_verification_consumptions consumed
      WHERE consumed.workspace_id = NEW.workspace_id
         AND consumed.verification_id = session_row.verification_id
         AND consumed.person_id = NEW.person_id
      )
     AND json_type(c.policy_json, '$.choices') IS 'array'
     AND NOT EXISTS (
       SELECT 1
       FROM json_each(c.policy_json, '$.choices') current_policy_choice
       WHERE current_policy_choice.type IS NOT 'object'
     )
     AND (
      (
        s.current_revision_id IS NULL
        AND NEW.revision_number = 1
        AND NOT EXISTS (
          SELECT 1 FROM submission_revisions prior
          WHERE prior.workspace_id = NEW.workspace_id AND prior.submission_id = NEW.submission_id
        )
      )
      OR (
        s.current_revision_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM submission_revisions current_revision
          WHERE current_revision.id = s.current_revision_id
            AND current_revision.workspace_id = NEW.workspace_id
            AND current_revision.submission_id = NEW.submission_id
            AND NEW.revision_number = current_revision.revision_number + 1
        )
      )
    )
 )
OR NEW.revision_schema != 'cfp-submission-revision/v1'
OR NEW.fingerprint_algorithm != 'sha256-canonical-json-v1'
OR NEW.policy_schema != 'cfp-call-policy/v1'
OR NEW.policy_fingerprint_algorithm != 'sha256-canonical-json-v1'
OR NEW.form_document_schema != 'cfp-form-document/v1'
OR json_valid(NEW.revision_json) != 1
OR (
  json_valid(NEW.revision_json) = 1
  AND (
    json_extract(NEW.revision_json, '$.schema') IS NOT NEW.revision_schema
    OR json_extract(NEW.revision_json, '$.submissionId') IS NOT NEW.submission_id
    OR json_extract(NEW.revision_json, '$.revisionNumber') IS NOT NEW.revision_number
    OR json_extract(NEW.revision_json, '$.fingerprintAlgorithm') IS NOT NEW.fingerprint_algorithm
    OR json_extract(NEW.revision_json, '$.fingerprint') IS NOT NEW.fingerprint
    OR json_extract(NEW.revision_json, '$.formDocument.schema') IS NOT NEW.form_document_schema
    OR json_extract(NEW.revision_json, '$.formDocument.formVersionId') IS NOT NEW.form_version_id
    OR json_extract(NEW.revision_json, '$.formDocument.ruleVersionId') IS NOT NEW.rule_version_id
    OR json_extract(NEW.revision_json, '$.formDocument.fingerprint') IS NOT NEW.form_document_fingerprint
    OR json_extract(NEW.revision_json, '$.callPolicy.schema') IS NOT NEW.policy_schema
    OR json_extract(NEW.revision_json, '$.callPolicy.policyVersionId') IS NOT NEW.policy_version_id
     OR json_extract(NEW.revision_json, '$.callPolicy.fingerprintAlgorithm') IS NOT NEW.policy_fingerprint_algorithm
            OR json_extract(NEW.revision_json, '$.callPolicy.fingerprint') IS NOT NEW.policy_fingerprint
            OR json_type(NEW.revision_json, '$.callPolicy') IS NOT 'object'
            OR (SELECT COUNT(*) FROM json_each(NEW.revision_json, '$.callPolicy')) != 6
            OR EXISTS (
              SELECT 1
              FROM json_each(NEW.revision_json, '$.callPolicy') policy_key
              WHERE policy_key.key NOT IN (
                'schema', 'policyVersionId', 'disclosure', 'choices',
                'fingerprintAlgorithm', 'fingerprint'
              )
            )
            OR json_type(NEW.revision_json, '$.callPolicy.choices') IS NOT 'array'
            OR EXISTS (
              SELECT 1
              FROM json_each(NEW.revision_json, '$.callPolicy.choices') retained_choice
              WHERE retained_choice.type IS NOT 'object'
            )
            OR (
       NEW.consent_receipt_schema IS NULL
       AND (
         NEW.consent_receipt_policy_fingerprint IS NOT NULL
         OR json_type(NEW.revision_json, '$.consentReceipt') IS NOT 'null'
       )
     )
     OR (
       NEW.consent_receipt_schema IS NOT NULL
       AND (
         NEW.consent_receipt_policy_fingerprint IS NULL
         OR NEW.consent_receipt_schema != 'cfp-consent-receipt/v1'
            OR json_type(NEW.revision_json, '$.consentReceipt') IS NOT 'object'
         OR json_extract(NEW.revision_json, '$.consentReceipt.schema') IS NOT NEW.consent_receipt_schema
         OR json_extract(NEW.revision_json, '$.consentReceipt.submissionId') IS NOT NEW.submission_id
         OR json_extract(NEW.revision_json, '$.consentReceipt.personId') IS NOT NEW.person_id
         OR json_extract(NEW.revision_json, '$.consentReceipt.applicantSessionId') IS NOT NEW.session_id
         OR json_extract(NEW.revision_json, '$.consentReceipt.receivedAt') IS NOT NEW.created_at
          OR json_extract(NEW.revision_json, '$.consentReceipt.policyFingerprint') IS NOT NEW.consent_receipt_policy_fingerprint
           OR json_extract(NEW.revision_json, '$.consentReceipt.policyFingerprint') IS NOT NEW.policy_fingerprint
           OR (SELECT COUNT(*) FROM json_each(NEW.revision_json, '$.consentReceipt')) != 7
           OR EXISTS (
             SELECT 1
             FROM json_each(NEW.revision_json, '$.consentReceipt') receipt_key
             WHERE receipt_key.key NOT IN (
               'schema', 'submissionId', 'personId', 'applicantSessionId',
               'receivedAt', 'policyFingerprint', 'choices'
             )
           )
           OR json_type(NEW.revision_json, '$.consentReceipt.schema') IS NOT 'text'
           OR json_type(NEW.revision_json, '$.consentReceipt.submissionId') IS NOT 'text'
           OR json_type(NEW.revision_json, '$.consentReceipt.personId') IS NOT 'text'
           OR json_type(NEW.revision_json, '$.consentReceipt.applicantSessionId') IS NOT 'text'
           OR json_type(NEW.revision_json, '$.consentReceipt.receivedAt') IS NOT 'text'
           OR json_type(NEW.revision_json, '$.consentReceipt.policyFingerprint') IS NOT 'text'
            OR json_type(NEW.revision_json, '$.callPolicy.choices') IS NOT 'array'
           OR json_type(NEW.revision_json, '$.consentReceipt.choices') IS NOT 'array'
            OR EXISTS (
              SELECT 1
              FROM json_each(NEW.revision_json, '$.callPolicy.choices') retained_choice
              WHERE retained_choice.type IS NOT 'object'
            )
            OR EXISTS (
              SELECT 1
              FROM json_each(NEW.revision_json, '$.consentReceipt.choices') receipt_choice
              WHERE receipt_choice.type IS NOT 'object'
            )
            OR json_array_length(NEW.revision_json, '$.consentReceipt.choices') !=
              json_array_length(NEW.revision_json, '$.callPolicy.choices')
          OR EXISTS (
            SELECT 1
            FROM json_each(NEW.revision_json, '$.callPolicy.choices') policy_choice
            WHERE NOT EXISTS (
              SELECT 1
              FROM json_each(NEW.revision_json, '$.consentReceipt.choices') receipt_choice
              WHERE receipt_choice.key = policy_choice.key
                AND policy_choice.type = 'object'
                AND receipt_choice.type = 'object'
                AND (SELECT COUNT(*) FROM json_each(receipt_choice.value)) = 2
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(receipt_choice.value) receipt_key
                  WHERE receipt_key.key NOT IN ('fieldId', 'value')
                )
                AND json_type(receipt_choice.value, '$.fieldId') = 'text'
                AND json_extract(receipt_choice.value, '$.fieldId') =
                    json_extract(policy_choice.value, '$.fieldId')
                AND json_type(receipt_choice.value, '$.value') IN ('true', 'false')
            )
          )
        )
     )
  )
)
BEGIN SELECT RAISE(ABORT, 'submission_revisions workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_form_definitions_identity_immutable BEFORE UPDATE ON form_definitions
WHEN NEW.id != OLD.id OR NEW.workspace_id != OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'form_definitions identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_form_definitions_no_delete BEFORE DELETE ON form_definitions
BEGIN SELECT RAISE(ABORT, 'form_definitions is retained for history'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_rule_versions_immutable BEFORE UPDATE ON rule_versions
BEGIN SELECT RAISE(ABORT, 'rule_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_rule_versions_no_delete BEFORE DELETE ON rule_versions
BEGIN SELECT RAISE(ABORT, 'rule_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_form_versions_immutable BEFORE UPDATE ON form_versions
BEGIN SELECT RAISE(ABORT, 'form_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_form_versions_no_delete BEFORE DELETE ON form_versions
BEGIN SELECT RAISE(ABORT, 'form_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_call_extensions_immutable BEFORE UPDATE ON call_extensions
BEGIN SELECT RAISE(ABORT, 'call_extensions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_call_extensions_no_delete BEFORE DELETE ON call_extensions
BEGIN SELECT RAISE(ABORT, 'call_extensions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_email_verifications_immutable BEFORE UPDATE ON cfp_email_verifications
BEGIN SELECT RAISE(ABORT, 'cfp_email_verifications is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_email_verifications_no_delete BEFORE DELETE ON cfp_email_verifications
BEGIN SELECT RAISE(ABORT, 'cfp_email_verifications is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_email_verification_consumptions_immutable BEFORE UPDATE ON cfp_email_verification_consumptions
BEGIN SELECT RAISE(ABORT, 'cfp_email_verification_consumptions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_email_verification_consumptions_no_delete BEFORE DELETE ON cfp_email_verification_consumptions
BEGIN SELECT RAISE(ABORT, 'cfp_email_verification_consumptions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_submission_revisions_immutable BEFORE UPDATE ON submission_revisions
BEGIN SELECT RAISE(ABORT, 'submission_revisions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_submission_revisions_no_delete BEFORE DELETE ON submission_revisions
BEGIN SELECT RAISE(ABORT, 'submission_revisions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cfp_submissions_no_delete BEFORE DELETE ON submissions
BEGIN SELECT RAISE(ABORT, 'submissions is retained for history'); END;

-- Review persistence tables (V4).
CREATE TABLE IF NOT EXISTS review_rounds (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, call_id, name)
) STRICT;

CREATE TABLE IF NOT EXISTS review_round_states (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  round_id TEXT NOT NULL REFERENCES review_rounds(id),
  state TEXT NOT NULL CHECK (state IN ('DRAFT', 'OPEN', 'CLOSED', 'CANCELLED')),
  sequence_number INTEGER NOT NULL CHECK (typeof(sequence_number) = 'integer' AND sequence_number >= 1),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (round_id, sequence_number)
) STRICT;

CREATE TABLE IF NOT EXISTS rubric_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  round_id TEXT NOT NULL REFERENCES review_rounds(id),
  version_number INTEGER NOT NULL CHECK (typeof(version_number) = 'integer' AND version_number >= 1),
  rubric_schema TEXT NOT NULL CHECK (rubric_schema = 'cfp-rubric/v1'),
  rubric_json TEXT NOT NULL CHECK (
    typeof(rubric_json) = 'text'
    AND json_valid(rubric_json) = 1
    AND length(CAST(rubric_json AS BLOB)) <= 4194304
  ),
  fingerprint_algorithm TEXT NOT NULL CHECK (fingerprint_algorithm = 'sha256-canonical-json-v1'),
  fingerprint TEXT NOT NULL CHECK (
    typeof(fingerprint) = 'text'
    AND length(fingerprint) = 64
    AND length(CAST(fingerprint AS BLOB)) = 64
    AND NOT (fingerprint GLOB '*[^0-9a-f]*')
  ),
  sealed_by TEXT NOT NULL REFERENCES accounts(id),
  sealed_at TEXT NOT NULL CHECK (length(sealed_at) > 0),
  UNIQUE (round_id, version_number),
  UNIQUE (workspace_id, fingerprint)
) STRICT;

CREATE TABLE IF NOT EXISTS review_assignments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  round_id TEXT NOT NULL REFERENCES review_rounds(id),
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  submission_revision_id TEXT NOT NULL REFERENCES submission_revisions(id),
  reviewer_account_id TEXT NOT NULL REFERENCES accounts(id),
  assigned_by TEXT NOT NULL REFERENCES accounts(id),
  supersedes_assignment_id TEXT REFERENCES review_assignments(id),
  created_at TEXT NOT NULL,
  UNIQUE (round_id, submission_revision_id, reviewer_account_id),
  UNIQUE (supersedes_assignment_id)
) STRICT;

CREATE TABLE IF NOT EXISTS review_assignment_states (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  assignment_id TEXT NOT NULL REFERENCES review_assignments(id),
  state TEXT NOT NULL CHECK (state IN ('ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'RECUSED', 'REVOKED')),
  sequence_number INTEGER NOT NULL CHECK (typeof(sequence_number) = 'integer' AND sequence_number >= 1),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (assignment_id, sequence_number)
) STRICT;

CREATE TABLE IF NOT EXISTS review_conflict_dispositions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  assignment_id TEXT NOT NULL REFERENCES review_assignments(id),
  action TEXT NOT NULL CHECK (action IN ('DECLARE', 'CLEAR', 'WAIVE')),
  sequence_number INTEGER NOT NULL CHECK (typeof(sequence_number) = 'integer' AND sequence_number >= 1),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  actor_role_basis TEXT NOT NULL CHECK (
    typeof(actor_role_basis) = 'text'
    AND length(CAST(actor_role_basis AS BLOB)) BETWEEN 1 AND 128
  ),
  reason TEXT NOT NULL CHECK (
    typeof(reason) = 'text'
    AND length(CAST(reason AS BLOB)) BETWEEN 1 AND 4096
  ),
  created_at TEXT NOT NULL,
  UNIQUE (assignment_id, sequence_number)
) STRICT;

CREATE TABLE IF NOT EXISTS review_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  assignment_id TEXT NOT NULL REFERENCES review_assignments(id),
  round_id TEXT NOT NULL REFERENCES review_rounds(id),
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  submission_revision_id TEXT NOT NULL REFERENCES submission_revisions(id),
  revision_number INTEGER NOT NULL CHECK (typeof(revision_number) = 'integer' AND revision_number >= 1),
  evaluation_schema TEXT NOT NULL CHECK (evaluation_schema = 'cfp-review-evaluation/v1'),
  evaluation_json TEXT NOT NULL CHECK (
    typeof(evaluation_json) = 'text'
    AND json_valid(evaluation_json) = 1
    AND length(CAST(evaluation_json AS BLOB)) <= 4194304
  ),
  fingerprint_algorithm TEXT NOT NULL CHECK (fingerprint_algorithm = 'sha256-canonical-json-v1'),
  fingerprint TEXT NOT NULL CHECK (
    typeof(fingerprint) = 'text'
    AND length(fingerprint) = 64
    AND length(CAST(fingerprint AS BLOB)) = 64
    AND NOT (fingerprint GLOB '*[^0-9a-f]*')
  ),
  created_at TEXT NOT NULL,
  UNIQUE (assignment_id, revision_number),
  UNIQUE (workspace_id, fingerprint)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_review_rounds_call ON review_rounds(workspace_id, call_id);
CREATE INDEX IF NOT EXISTS idx_review_round_states_round ON review_round_states(workspace_id, round_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_rubric_versions_round ON rubric_versions(workspace_id, round_id, version_number);
CREATE INDEX IF NOT EXISTS idx_review_assignments_round ON review_assignments(workspace_id, round_id);
CREATE INDEX IF NOT EXISTS idx_review_assignments_submission ON review_assignments(workspace_id, submission_id, submission_revision_id);
CREATE INDEX IF NOT EXISTS idx_review_assignments_reviewer ON review_assignments(workspace_id, reviewer_account_id);
CREATE INDEX IF NOT EXISTS idx_review_assignment_states_assignment ON review_assignment_states(workspace_id, assignment_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_review_conflict_dispositions_assignment ON review_conflict_dispositions(workspace_id, assignment_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_review_revisions_assignment ON review_revisions(workspace_id, assignment_id, revision_number);

CREATE TRIGGER IF NOT EXISTS trg_review_rounds_workspace_guard BEFORE INSERT ON review_rounds
WHEN NOT EXISTS (
  SELECT 1 FROM events e, calls c, accounts a
  WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
    AND c.id = NEW.call_id AND c.workspace_id = NEW.workspace_id
    AND c.event_id = NEW.event_id
    AND a.id = NEW.created_by AND a.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'review_rounds workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_rounds_immutable BEFORE UPDATE ON review_rounds
BEGIN SELECT RAISE(ABORT, 'review_rounds is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_rounds_no_delete BEFORE DELETE ON review_rounds
BEGIN SELECT RAISE(ABORT, 'review_rounds is retained for history'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_rounds_initialize_state AFTER INSERT ON review_rounds
BEGIN
  SELECT RAISE(ABORT, 'review_rounds initial state collision')
  WHERE EXISTS (
    SELECT 1 FROM review_round_states
    WHERE id = 'review-round-state-initial:' || NEW.id
  )
  OR EXISTS (
    SELECT 1 FROM review_round_states
    WHERE round_id = NEW.id AND sequence_number = 1
  );
  INSERT INTO review_round_states
    (id, workspace_id, round_id, state, sequence_number, actor_account_id, reason, created_at)
  VALUES
    ('review-round-state-initial:' || NEW.id, NEW.workspace_id, NEW.id, 'DRAFT', 1,
     NEW.created_by, NULL, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_review_round_states_workspace_guard BEFORE INSERT ON review_round_states
WHEN NOT EXISTS (
  SELECT 1 FROM review_rounds r, accounts a
  WHERE r.id = NEW.round_id AND r.workspace_id = NEW.workspace_id
    AND a.id = NEW.actor_account_id AND a.workspace_id = NEW.workspace_id
)
OR (
  NEW.sequence_number = 1 AND NEW.state != 'DRAFT'
)
OR (
  NEW.sequence_number = 1 AND EXISTS (
    SELECT 1 FROM review_round_states prior
    WHERE prior.round_id = NEW.round_id
  )
)
OR (
  NEW.sequence_number > 1 AND NOT EXISTS (
    SELECT 1 FROM review_round_states prior
    WHERE prior.round_id = NEW.round_id
      AND prior.sequence_number = NEW.sequence_number - 1
      AND (
        (prior.state = 'DRAFT' AND NEW.state IN ('OPEN', 'CANCELLED'))
        OR (prior.state = 'OPEN' AND NEW.state IN ('CLOSED', 'CANCELLED'))
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'review_round_states workspace or state transition mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_round_states_immutable BEFORE UPDATE ON review_round_states
BEGIN SELECT RAISE(ABORT, 'review_round_states is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_round_states_no_delete BEFORE DELETE ON review_round_states
BEGIN SELECT RAISE(ABORT, 'review_round_states is retained for history'); END;

CREATE TRIGGER IF NOT EXISTS trg_rubric_versions_workspace_guard BEFORE INSERT ON rubric_versions
WHEN NOT EXISTS (
  SELECT 1 FROM review_rounds r, accounts a
  WHERE r.id = NEW.round_id AND r.workspace_id = NEW.workspace_id
    AND a.id = NEW.sealed_by AND a.workspace_id = NEW.workspace_id
)
OR NEW.rubric_schema != 'cfp-rubric/v1'
OR NEW.fingerprint_algorithm != 'sha256-canonical-json-v1'
OR length(NEW.sealed_at) = 0
OR json_valid(NEW.rubric_json) != 1
BEGIN SELECT RAISE(ABORT, 'rubric_versions workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_rubric_versions_immutable BEFORE UPDATE ON rubric_versions
BEGIN SELECT RAISE(ABORT, 'rubric_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_rubric_versions_no_delete BEFORE DELETE ON rubric_versions
BEGIN SELECT RAISE(ABORT, 'rubric_versions is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_assignments_workspace_guard BEFORE INSERT ON review_assignments
WHEN NOT EXISTS (
  SELECT 1
  FROM review_rounds round, rubric_versions rubric, submissions sub,
       submission_revisions rev, accounts reviewer, accounts assigner
  WHERE round.id = NEW.round_id AND round.workspace_id = NEW.workspace_id
    AND rubric.id = NEW.rubric_version_id AND rubric.workspace_id = NEW.workspace_id
    AND rubric.round_id = NEW.round_id
    AND sub.id = NEW.submission_id AND sub.workspace_id = NEW.workspace_id
    AND sub.event_id = round.event_id AND sub.call_id = round.call_id
    AND rev.id = NEW.submission_revision_id AND rev.workspace_id = NEW.workspace_id
    AND rev.submission_id = NEW.submission_id
    AND reviewer.id = NEW.reviewer_account_id AND reviewer.workspace_id = NEW.workspace_id
    AND assigner.id = NEW.assigned_by AND assigner.workspace_id = NEW.workspace_id
)
OR (
  NEW.supersedes_assignment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM review_assignments prior
    WHERE prior.id = NEW.supersedes_assignment_id
      AND prior.workspace_id = NEW.workspace_id
      AND prior.round_id = NEW.round_id
      AND prior.submission_id = NEW.submission_id
      AND prior.submission_revision_id = NEW.submission_revision_id
      AND prior.id != NEW.id
      AND EXISTS (
        SELECT 1 FROM review_assignment_states prior_state
        WHERE prior_state.assignment_id = NEW.supersedes_assignment_id
          AND prior_state.sequence_number = (
            SELECT MAX(s.sequence_number)
            FROM review_assignment_states s
            WHERE s.assignment_id = NEW.supersedes_assignment_id
          )
          AND prior_state.state IN ('RECUSED', 'REVOKED')
      )
      AND NOT EXISTS (
        WITH RECURSIVE chain(curr_id) AS (
          SELECT NEW.supersedes_assignment_id
          UNION ALL
          SELECT a.supersedes_assignment_id
          FROM chain
          JOIN review_assignments a ON a.id = chain.curr_id
          WHERE a.supersedes_assignment_id IS NOT NULL
        )
        SELECT 1 FROM chain WHERE curr_id = NEW.id
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'review_assignments workspace, predecessor state, or lineage cycle mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_assignments_immutable BEFORE UPDATE ON review_assignments
BEGIN SELECT RAISE(ABORT, 'review_assignments is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_assignments_no_delete BEFORE DELETE ON review_assignments
BEGIN SELECT RAISE(ABORT, 'review_assignments is retained for history'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_assignments_initialize_state AFTER INSERT ON review_assignments
BEGIN
  SELECT RAISE(ABORT, 'review_assignments initial state collision')
  WHERE EXISTS (
    SELECT 1 FROM review_assignment_states
    WHERE id = 'review-assignment-state-initial:' || NEW.id
  )
  OR EXISTS (
    SELECT 1 FROM review_assignment_states
    WHERE assignment_id = NEW.id AND sequence_number = 1
  );
  INSERT INTO review_assignment_states
    (id, workspace_id, assignment_id, state, sequence_number, actor_account_id, reason, created_at)
  VALUES
    ('review-assignment-state-initial:' || NEW.id, NEW.workspace_id, NEW.id, 'ASSIGNED', 1,
     NEW.assigned_by, NULL, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_review_assignment_states_workspace_guard BEFORE INSERT ON review_assignment_states
WHEN NOT EXISTS (
  SELECT 1 FROM review_assignments a, accounts actor
  WHERE a.id = NEW.assignment_id AND a.workspace_id = NEW.workspace_id
    AND actor.id = NEW.actor_account_id AND actor.workspace_id = NEW.workspace_id
)
OR (
  NEW.sequence_number = 1 AND NEW.state != 'ASSIGNED'
)
OR (
  NEW.sequence_number = 1 AND EXISTS (
    SELECT 1 FROM review_assignment_states prior
    WHERE prior.assignment_id = NEW.assignment_id
  )
)
OR (
  NEW.sequence_number > 1 AND NOT EXISTS (
    SELECT 1 FROM review_assignment_states prior
    WHERE prior.assignment_id = NEW.assignment_id
      AND prior.sequence_number = NEW.sequence_number - 1
      AND (
        (prior.state = 'ASSIGNED' AND NEW.state IN ('IN_PROGRESS', 'SUBMITTED', 'RECUSED', 'REVOKED'))
        OR (prior.state = 'IN_PROGRESS' AND NEW.state IN ('SUBMITTED', 'RECUSED', 'REVOKED'))
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'review_assignment_states workspace or state transition mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_assignment_states_immutable BEFORE UPDATE ON review_assignment_states
BEGIN SELECT RAISE(ABORT, 'review_assignment_states is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_assignment_states_no_delete BEFORE DELETE ON review_assignment_states
BEGIN SELECT RAISE(ABORT, 'review_assignment_states is retained for history'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_conflict_dispositions_workspace_guard BEFORE INSERT ON review_conflict_dispositions
WHEN NOT EXISTS (
  SELECT 1 FROM review_assignments a, accounts actor
  WHERE a.id = NEW.assignment_id AND a.workspace_id = NEW.workspace_id
    AND actor.id = NEW.actor_account_id AND actor.workspace_id = NEW.workspace_id
)
OR (
  NEW.sequence_number = 1 AND NEW.action != 'DECLARE'
)
OR (
  NEW.sequence_number = 1 AND EXISTS (
    SELECT 1 FROM review_conflict_dispositions prior
    WHERE prior.assignment_id = NEW.assignment_id
  )
)
OR (
  NEW.sequence_number > 1 AND NOT EXISTS (
    SELECT 1 FROM review_conflict_dispositions prior
    WHERE prior.assignment_id = NEW.assignment_id
      AND prior.sequence_number = NEW.sequence_number - 1
      AND (
        (prior.action = 'DECLARE' AND NEW.action IN ('CLEAR', 'WAIVE'))
        OR (prior.action = 'CLEAR' AND NEW.action = 'DECLARE')
      )
  )
)
BEGIN SELECT RAISE(ABORT, 'review_conflict_dispositions workspace, sequence, or transition mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_conflict_dispositions_immutable BEFORE UPDATE ON review_conflict_dispositions
BEGIN SELECT RAISE(ABORT, 'review_conflict_dispositions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_conflict_dispositions_no_delete BEFORE DELETE ON review_conflict_dispositions
BEGIN SELECT RAISE(ABORT, 'review_conflict_dispositions is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_revisions_workspace_guard BEFORE INSERT ON review_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM review_assignments a
  WHERE a.id = NEW.assignment_id AND a.workspace_id = NEW.workspace_id
    AND a.round_id = NEW.round_id
    AND a.rubric_version_id = NEW.rubric_version_id
    AND a.submission_id = NEW.submission_id
    AND a.submission_revision_id = NEW.submission_revision_id
)
OR NEW.evaluation_schema != 'cfp-review-evaluation/v1'
OR NEW.fingerprint_algorithm != 'sha256-canonical-json-v1'
OR json_valid(NEW.evaluation_json) != 1
OR (
  NEW.revision_number = 1 AND EXISTS (
    SELECT 1 FROM review_revisions prior
    WHERE prior.assignment_id = NEW.assignment_id
  )
)
OR (
  NEW.revision_number > 1 AND NOT EXISTS (
    SELECT 1 FROM review_revisions prior
    WHERE prior.assignment_id = NEW.assignment_id
      AND prior.revision_number = NEW.revision_number - 1
  )
)
BEGIN SELECT RAISE(ABORT, 'review_revisions workspace, tuple binding, or sequence mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_revisions_immutable BEFORE UPDATE ON review_revisions
BEGIN SELECT RAISE(ABORT, 'review_revisions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_revisions_no_delete BEFORE DELETE ON review_revisions
BEGIN SELECT RAISE(ABORT, 'review_revisions is immutable'); END;
`;

// V5 is an additive trust packet. Keep this separate from the complete fresh-install DDL so the
// V4 migration executes only new physical objects and never reissues accepted V4 definitions.
export const V5_DDL = `
CREATE TABLE IF NOT EXISTS review_rubric_semantics (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  round_id TEXT NOT NULL REFERENCES review_rounds(id),
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  rubric_version_number INTEGER NOT NULL
    CHECK (typeof(rubric_version_number) = 'integer' AND rubric_version_number >= 1),
  rubric_version_fingerprint TEXT NOT NULL
    CHECK (
      typeof(rubric_version_fingerprint) = 'text'
      AND length(rubric_version_fingerprint) = 64
      AND length(CAST(rubric_version_fingerprint AS BLOB)) = 64
      AND NOT (rubric_version_fingerprint GLOB '*[^0-9a-f]*')
    ),
  semantics_schema TEXT NOT NULL
    CHECK (semantics_schema = 'cfp-review-rubric-semantics/v1'),
  semantics_version INTEGER NOT NULL
    CHECK (typeof(semantics_version) = 'integer' AND semantics_version = 1),
  semantics_json TEXT NOT NULL
    CHECK (
      typeof(semantics_json) = 'text'
      AND json_valid(semantics_json) = 1
      AND length(CAST(semantics_json AS BLOB)) <= 524288
    ),
  fingerprint_algorithm TEXT NOT NULL
    CHECK (fingerprint_algorithm = 'sha256-canonical-json-v1'),
  fingerprint TEXT NOT NULL
    CHECK (
      typeof(fingerprint) = 'text'
      AND length(fingerprint) = 64
      AND length(CAST(fingerprint AS BLOB)) = 64
      AND NOT (fingerprint GLOB '*[^0-9a-f]*')
    ),
  issued_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  issuer_role TEXT NOT NULL
    CHECK (length(CAST(issuer_role AS BLOB)) BETWEEN 1 AND 128),
  issuer_authority TEXT NOT NULL
    CHECK (issuer_authority = 'phase0.pipeline.manage'),
  idempotency_key TEXT NOT NULL
    CHECK (length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128),
  request_fingerprint_algorithm TEXT NOT NULL
    CHECK (request_fingerprint_algorithm = 'sha256-canonical-json-v1'),
  request_fingerprint TEXT NOT NULL
    CHECK (
      length(request_fingerprint) = 64
      AND NOT (request_fingerprint GLOB '*[^0-9a-f]*')
    ),
  issued_at TEXT NOT NULL CHECK (length(issued_at) > 0),
  UNIQUE (rubric_version_id),
  UNIQUE (workspace_id, fingerprint),
  UNIQUE (workspace_id, issued_by_account_id, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS review_blind_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  assignment_id TEXT NOT NULL REFERENCES review_assignments(id),
  assignment_created_at TEXT NOT NULL,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  rubric_semantics_id TEXT NOT NULL REFERENCES review_rubric_semantics(id),
  rubric_semantics_fingerprint TEXT NOT NULL,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  submission_revision_id TEXT NOT NULL REFERENCES submission_revisions(id),
  submission_revision_number INTEGER NOT NULL
    CHECK (typeof(submission_revision_number) = 'integer'
           AND submission_revision_number >= 1),
  submission_revision_schema TEXT NOT NULL
    CHECK (submission_revision_schema = 'cfp-submission-revision/v1'),
  submission_revision_fingerprint_algorithm TEXT NOT NULL
    CHECK (submission_revision_fingerprint_algorithm = 'sha256-canonical-json-v1'),
  submission_revision_fingerprint TEXT NOT NULL
    CHECK (
      length(submission_revision_fingerprint) = 64
      AND NOT (submission_revision_fingerprint GLOB '*[^0-9a-f]*')
    ),
  submission_revision_created_at TEXT NOT NULL,
  form_document_schema TEXT NOT NULL
    CHECK (form_document_schema = 'cfp-form-document/v1'),
  form_version_id TEXT NOT NULL REFERENCES form_versions(id),
  rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
  form_document_fingerprint TEXT NOT NULL
    CHECK (
      length(form_document_fingerprint) = 64
      AND NOT (form_document_fingerprint GLOB '*[^0-9a-f]*')
    ),
  disclosure_stage TEXT NOT NULL
    CHECK (disclosure_stage = 'BLIND_REVIEW'),
  conflict_status_at_issuance TEXT NOT NULL
    CHECK (conflict_status_at_issuance IN ('NONE', 'CLEARED', 'WAIVED')),
  conflict_sequence_at_issuance INTEGER NOT NULL
    CHECK (
      typeof(conflict_sequence_at_issuance) = 'integer'
      AND conflict_sequence_at_issuance >= 0
      AND (
        (conflict_status_at_issuance = 'NONE'
         AND conflict_sequence_at_issuance = 0)
        OR
        (conflict_status_at_issuance IN ('CLEARED', 'WAIVED')
         AND conflict_sequence_at_issuance >= 1)
      )
    ),
  artifact_schema TEXT NOT NULL
    CHECK (artifact_schema = 'cfp-review-blind-artifact/v1'),
  artifact_version INTEGER NOT NULL
    CHECK (typeof(artifact_version) = 'integer' AND artifact_version = 1),
  artifact_json TEXT NOT NULL
    CHECK (
      typeof(artifact_json) = 'text'
      AND json_valid(artifact_json) = 1
      AND length(CAST(artifact_json AS BLOB)) <= 4194304
    ),
  fingerprint_algorithm TEXT NOT NULL
    CHECK (fingerprint_algorithm = 'sha256-canonical-json-v1'),
  fingerprint TEXT NOT NULL
    CHECK (
      length(fingerprint) = 64
      AND NOT (fingerprint GLOB '*[^0-9a-f]*')
    ),
  blind_safety_attestation TEXT NOT NULL
    CHECK (
      blind_safety_attestation =
      'ORGANIZER_VERIFIED_BLIND_SAFE_REDACTION'
    ),
  issued_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  issuer_role TEXT NOT NULL
    CHECK (length(CAST(issuer_role AS BLOB)) BETWEEN 1 AND 128),
  issuer_authority TEXT NOT NULL
    CHECK (issuer_authority = 'phase0.pipeline.manage'),
  idempotency_key TEXT NOT NULL
    CHECK (length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128),
  request_fingerprint_algorithm TEXT NOT NULL
    CHECK (request_fingerprint_algorithm = 'sha256-canonical-json-v1'),
  request_fingerprint TEXT NOT NULL
    CHECK (
      length(request_fingerprint) = 64
      AND NOT (request_fingerprint GLOB '*[^0-9a-f]*')
    ),
  issued_at TEXT NOT NULL CHECK (length(issued_at) > 0),
  UNIQUE (assignment_id),
  UNIQUE (workspace_id, fingerprint),
  UNIQUE (workspace_id, issued_by_account_id, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS review_command_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  assignment_id TEXT NOT NULL REFERENCES review_assignments(id),
  round_id TEXT NOT NULL REFERENCES review_rounds(id),
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  submission_revision_id TEXT NOT NULL REFERENCES submission_revisions(id),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  command_kind TEXT NOT NULL CHECK (
    command_kind IN (
      'CONFLICT_DECLARE',
      'CONFLICT_CLEAR',
      'SAVE_REVIEW',
      'SUBMIT_REVIEW'
    )
  ),
  idempotency_key TEXT NOT NULL
    CHECK (length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128),
  request_schema TEXT NOT NULL
    CHECK (request_schema = 'cfp-review-command-request/v1'),
  request_fingerprint_algorithm TEXT NOT NULL
    CHECK (request_fingerprint_algorithm = 'sha256-canonical-json-v1'),
  request_fingerprint TEXT NOT NULL
    CHECK (
      length(request_fingerprint) = 64
      AND NOT (request_fingerprint GLOB '*[^0-9a-f]*')
    ),
  effect_id TEXT NOT NULL,
  receipt_schema TEXT NOT NULL
    CHECK (receipt_schema = 'cfp-review-command-receipt/v1'),
  receipt_json TEXT NOT NULL
    CHECK (
      typeof(receipt_json) = 'text'
      AND json_valid(receipt_json) = 1
      AND length(CAST(receipt_json AS BLOB)) <= 65536
    ),
  receipt_fingerprint_algorithm TEXT NOT NULL
    CHECK (receipt_fingerprint_algorithm = 'sha256-canonical-json-v1'),
  receipt_fingerprint TEXT NOT NULL
    CHECK (
      length(receipt_fingerprint) = 64
      AND NOT (receipt_fingerprint GLOB '*[^0-9a-f]*')
    ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  UNIQUE (workspace_id, actor_account_id, command_kind, idempotency_key),
  UNIQUE (workspace_id, receipt_fingerprint)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_review_rubric_semantics_version
  ON review_rubric_semantics(workspace_id, round_id, rubric_version_id);

CREATE INDEX IF NOT EXISTS idx_review_blind_artifacts_assignment
  ON review_blind_artifacts(workspace_id, assignment_id);

CREATE INDEX IF NOT EXISTS idx_review_blind_artifacts_revision
  ON review_blind_artifacts(workspace_id, submission_revision_id);

CREATE INDEX IF NOT EXISTS idx_review_command_receipts_lookup
  ON review_command_receipts(
    workspace_id, actor_account_id, command_kind, idempotency_key
  );

CREATE INDEX IF NOT EXISTS idx_review_command_receipts_assignment
  ON review_command_receipts(workspace_id, assignment_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_review_rubric_semantics_guard
BEFORE INSERT ON review_rubric_semantics
WHEN length(CAST(NEW.rubric_version_fingerprint AS BLOB)) != 64
OR length(CAST(NEW.fingerprint AS BLOB)) != 64
OR length(CAST(NEW.request_fingerprint AS BLOB)) != 64
OR NEW.issuer_role NOT IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
OR NOT EXISTS (
  SELECT 1
  FROM rubric_versions rubric
  JOIN review_rounds round ON round.id = rubric.round_id
  JOIN accounts issuer ON issuer.id = NEW.issued_by_account_id
  WHERE rubric.id = NEW.rubric_version_id
    AND rubric.workspace_id = NEW.workspace_id
    AND rubric.round_id = NEW.round_id
    AND rubric.version_number = NEW.rubric_version_number
    AND rubric.fingerprint = NEW.rubric_version_fingerprint
    AND round.id = NEW.round_id
    AND round.workspace_id = NEW.workspace_id
    AND issuer.workspace_id = NEW.workspace_id
    AND issuer.role = NEW.issuer_role
    AND issuer.role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
    AND (
      SELECT state
      FROM review_round_states
      WHERE round_id = NEW.round_id
      ORDER BY sequence_number DESC
      LIMIT 1
    ) IN ('DRAFT', 'OPEN')
)
OR json_type(NEW.semantics_json, '$') IS NOT 'object'
OR json_extract(NEW.semantics_json, '$.schema') IS NOT NEW.semantics_schema
OR json_extract(NEW.semantics_json, '$.version') IS NOT NEW.semantics_version
OR json_extract(NEW.semantics_json, '$.workspaceId') IS NOT NEW.workspace_id
OR json_extract(NEW.semantics_json, '$.roundId') IS NOT NEW.round_id
OR json_extract(NEW.semantics_json, '$.rubricVersionId') IS NOT NEW.rubric_version_id
OR json_extract(NEW.semantics_json, '$.rubricVersionNumber') IS NOT NEW.rubric_version_number
OR json_extract(NEW.semantics_json, '$.rubricVersionFingerprint') IS NOT NEW.rubric_version_fingerprint
OR json_extract(NEW.semantics_json, '$.issuer.accountId') IS NOT NEW.issued_by_account_id
OR json_extract(NEW.semantics_json, '$.issuer.role') IS NOT NEW.issuer_role
OR json_extract(NEW.semantics_json, '$.issuer.authority') IS NOT NEW.issuer_authority
OR json_extract(NEW.semantics_json, '$.issuedAt') IS NOT NEW.issued_at
BEGIN SELECT RAISE(ABORT, 'review_rubric_semantics binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_rubric_semantics_immutable
BEFORE UPDATE ON review_rubric_semantics
BEGIN SELECT RAISE(ABORT, 'review_rubric_semantics is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_rubric_semantics_no_delete
BEFORE DELETE ON review_rubric_semantics
BEGIN SELECT RAISE(ABORT, 'review_rubric_semantics is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_blind_artifacts_guard
BEFORE INSERT ON review_blind_artifacts
WHEN length(CAST(NEW.rubric_semantics_fingerprint AS BLOB)) != 64
OR NEW.rubric_semantics_fingerprint GLOB '*[^0-9a-f]*'
OR length(CAST(NEW.submission_revision_fingerprint AS BLOB)) != 64
OR length(CAST(NEW.form_document_fingerprint AS BLOB)) != 64
OR length(CAST(NEW.fingerprint AS BLOB)) != 64
OR length(CAST(NEW.request_fingerprint AS BLOB)) != 64
OR NEW.issuer_role NOT IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
OR NOT EXISTS (
  SELECT 1
  FROM review_assignments assignment
  JOIN review_rounds round ON round.id = assignment.round_id
  JOIN rubric_versions rubric ON rubric.id = assignment.rubric_version_id
  JOIN review_rubric_semantics semantics ON semantics.id = NEW.rubric_semantics_id
  JOIN submissions submission ON submission.id = assignment.submission_id
  JOIN submission_revisions revision ON revision.id = assignment.submission_revision_id
  JOIN form_versions form ON form.id = revision.form_version_id
  JOIN rule_versions rule ON rule.id = revision.rule_version_id
  JOIN accounts issuer ON issuer.id = NEW.issued_by_account_id
  WHERE assignment.id = NEW.assignment_id
    AND assignment.workspace_id = NEW.workspace_id
    AND assignment.created_at = NEW.assignment_created_at
    AND assignment.rubric_version_id = NEW.rubric_version_id
    AND assignment.submission_id = NEW.submission_id
    AND assignment.submission_revision_id = NEW.submission_revision_id
    AND round.workspace_id = NEW.workspace_id
    AND rubric.workspace_id = NEW.workspace_id
    AND rubric.round_id = assignment.round_id
    AND semantics.workspace_id = NEW.workspace_id
    AND semantics.round_id = assignment.round_id
    AND semantics.rubric_version_id = NEW.rubric_version_id
    AND semantics.fingerprint = NEW.rubric_semantics_fingerprint
    AND submission.workspace_id = NEW.workspace_id
    AND revision.workspace_id = NEW.workspace_id
    AND revision.submission_id = NEW.submission_id
    AND revision.revision_number = NEW.submission_revision_number
    AND revision.revision_schema = NEW.submission_revision_schema
    AND revision.fingerprint_algorithm = NEW.submission_revision_fingerprint_algorithm
    AND revision.fingerprint = NEW.submission_revision_fingerprint
    AND revision.created_at = NEW.submission_revision_created_at
    AND revision.form_document_schema = NEW.form_document_schema
    AND revision.form_version_id = NEW.form_version_id
    AND revision.rule_version_id = NEW.rule_version_id
    AND revision.form_document_fingerprint = NEW.form_document_fingerprint
    AND form.workspace_id = NEW.workspace_id
    AND form.document_schema = NEW.form_document_schema
    AND form.rule_version_id = NEW.rule_version_id
    AND rule.workspace_id = NEW.workspace_id
    AND rule.id = NEW.rule_version_id
    AND rule.form_definition_id = form.form_definition_id
    AND issuer.workspace_id = NEW.workspace_id
    AND issuer.role = NEW.issuer_role
    AND issuer.role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
    AND (
      SELECT state
      FROM review_round_states
      WHERE round_id = assignment.round_id
      ORDER BY sequence_number DESC
      LIMIT 1
    ) IN ('DRAFT', 'OPEN')
    AND (
      SELECT state
      FROM review_assignment_states
      WHERE assignment_id = NEW.assignment_id
      ORDER BY sequence_number DESC
      LIMIT 1
    ) IN ('ASSIGNED', 'IN_PROGRESS')
    AND (
      (
        NEW.conflict_status_at_issuance = 'NONE'
        AND NEW.conflict_sequence_at_issuance = 0
        AND NOT EXISTS (
          SELECT 1 FROM review_conflict_dispositions
          WHERE assignment_id = NEW.assignment_id
        )
      )
      OR EXISTS (
        SELECT 1
        FROM review_conflict_dispositions disposition
        WHERE disposition.assignment_id = NEW.assignment_id
          AND disposition.sequence_number = NEW.conflict_sequence_at_issuance
          AND disposition.sequence_number = (
            SELECT MAX(latest.sequence_number)
            FROM review_conflict_dispositions latest
            WHERE latest.assignment_id = NEW.assignment_id
          )
          AND (
            (NEW.conflict_status_at_issuance = 'CLEARED' AND disposition.action = 'CLEAR')
            OR (NEW.conflict_status_at_issuance = 'WAIVED' AND disposition.action = 'WAIVE')
          )
      )
    )
)
OR json_type(NEW.artifact_json, '$') IS NOT 'object'
OR json_extract(NEW.artifact_json, '$.schema') IS NOT NEW.artifact_schema
OR json_extract(NEW.artifact_json, '$.version') IS NOT NEW.artifact_version
OR json_extract(NEW.artifact_json, '$.workspaceId') IS NOT NEW.workspace_id
OR json_extract(NEW.artifact_json, '$.assignmentId') IS NOT NEW.assignment_id
OR json_extract(NEW.artifact_json, '$.assignmentCreatedAt') IS NOT NEW.assignment_created_at
OR json_extract(NEW.artifact_json, '$.rubricVersionId') IS NOT NEW.rubric_version_id
OR json_extract(NEW.artifact_json, '$.rubricSemanticsId') IS NOT NEW.rubric_semantics_id
OR json_extract(NEW.artifact_json, '$.rubricSemanticsFingerprint') IS NOT NEW.rubric_semantics_fingerprint
OR json_extract(NEW.artifact_json, '$.submissionId') IS NOT NEW.submission_id
OR json_extract(NEW.artifact_json, '$.submissionRevision.id') IS NOT NEW.submission_revision_id
OR json_extract(NEW.artifact_json, '$.submissionRevision.number') IS NOT NEW.submission_revision_number
OR json_extract(NEW.artifact_json, '$.submissionRevision.schema') IS NOT NEW.submission_revision_schema
OR json_extract(NEW.artifact_json, '$.submissionRevision.fingerprint') IS NOT NEW.submission_revision_fingerprint
OR json_extract(NEW.artifact_json, '$.submissionRevision.createdAt') IS NOT NEW.submission_revision_created_at
OR json_extract(NEW.artifact_json, '$.submissionRevision.formDocumentSchema') IS NOT NEW.form_document_schema
OR json_extract(NEW.artifact_json, '$.submissionRevision.formVersionId') IS NOT NEW.form_version_id
OR json_extract(NEW.artifact_json, '$.submissionRevision.ruleVersionId') IS NOT NEW.rule_version_id
OR json_extract(NEW.artifact_json, '$.submissionRevision.formDocumentFingerprint') IS NOT NEW.form_document_fingerprint
OR json_extract(NEW.artifact_json, '$.disclosureStage') IS NOT NEW.disclosure_stage
OR json_extract(NEW.artifact_json, '$.conflictAtIssuance.status') IS NOT NEW.conflict_status_at_issuance
OR json_extract(NEW.artifact_json, '$.conflictAtIssuance.sequenceNumber') IS NOT NEW.conflict_sequence_at_issuance
OR json_extract(NEW.artifact_json, '$.attestation') IS NOT NEW.blind_safety_attestation
OR json_extract(NEW.artifact_json, '$.issuer.accountId') IS NOT NEW.issued_by_account_id
OR json_extract(NEW.artifact_json, '$.issuer.role') IS NOT NEW.issuer_role
OR json_extract(NEW.artifact_json, '$.issuer.authority') IS NOT NEW.issuer_authority
OR json_extract(NEW.artifact_json, '$.issuedAt') IS NOT NEW.issued_at
BEGIN SELECT RAISE(ABORT, 'review_blind_artifacts binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_blind_artifacts_immutable
BEFORE UPDATE ON review_blind_artifacts
BEGIN SELECT RAISE(ABORT, 'review_blind_artifacts is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_blind_artifacts_no_delete
BEFORE DELETE ON review_blind_artifacts
BEGIN SELECT RAISE(ABORT, 'review_blind_artifacts is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_command_receipts_guard
BEFORE INSERT ON review_command_receipts
WHEN length(CAST(NEW.request_fingerprint AS BLOB)) != 64
OR length(CAST(NEW.receipt_fingerprint AS BLOB)) != 64
OR sympose_receipt_canonical_json(NEW.receipt_json) IS NOT NEW.receipt_json
OR sympose_receipt_fingerprint(NEW.receipt_json) IS NOT NEW.receipt_fingerprint
OR EXISTS (
  SELECT 1
  FROM review_command_receipts existing
  WHERE existing.workspace_id = NEW.workspace_id
    AND existing.command_kind = NEW.command_kind
    AND existing.effect_id = NEW.effect_id
)
OR NOT EXISTS (
  SELECT 1
  FROM review_assignments assignment
  JOIN review_rounds round ON round.id = assignment.round_id
  JOIN rubric_versions rubric ON rubric.id = assignment.rubric_version_id
  JOIN submission_revisions revision ON revision.id = assignment.submission_revision_id
  JOIN accounts actor ON actor.id = NEW.actor_account_id
  WHERE assignment.id = NEW.assignment_id
    AND assignment.workspace_id = NEW.workspace_id
    AND assignment.round_id = NEW.round_id
    AND assignment.rubric_version_id = NEW.rubric_version_id
    AND assignment.submission_revision_id = NEW.submission_revision_id
    AND assignment.reviewer_account_id = NEW.actor_account_id
    AND round.workspace_id = NEW.workspace_id
    AND rubric.workspace_id = NEW.workspace_id
    AND rubric.round_id = NEW.round_id
    AND revision.workspace_id = NEW.workspace_id
    AND revision.submission_id = assignment.submission_id
    AND actor.workspace_id = NEW.workspace_id
)
OR NOT (
  (
    NEW.command_kind = 'CONFLICT_DECLARE'
    AND EXISTS (
      SELECT 1 FROM review_conflict_dispositions effect
      WHERE effect.id = NEW.effect_id
        AND effect.workspace_id = NEW.workspace_id
        AND effect.assignment_id = NEW.assignment_id
        AND effect.action = 'DECLARE'
        AND effect.actor_account_id = NEW.actor_account_id
        AND effect.created_at = NEW.created_at
    )
  )
  OR (
    NEW.command_kind = 'CONFLICT_CLEAR'
    AND EXISTS (
      SELECT 1 FROM review_conflict_dispositions effect
      WHERE effect.id = NEW.effect_id
        AND effect.workspace_id = NEW.workspace_id
        AND effect.assignment_id = NEW.assignment_id
        AND effect.action = 'CLEAR'
        AND effect.actor_account_id = NEW.actor_account_id
        AND effect.created_at = NEW.created_at
    )
  )
  OR (
    NEW.command_kind = 'SAVE_REVIEW'
    AND EXISTS (
      SELECT 1 FROM review_revisions effect
      WHERE effect.id = NEW.effect_id
        AND effect.workspace_id = NEW.workspace_id
        AND effect.assignment_id = NEW.assignment_id
        AND effect.round_id = NEW.round_id
        AND effect.rubric_version_id = NEW.rubric_version_id
        AND effect.submission_revision_id = NEW.submission_revision_id
        AND effect.created_at = NEW.created_at
    )
  )
  OR (
    NEW.command_kind = 'SUBMIT_REVIEW'
    AND EXISTS (
      SELECT 1 FROM review_assignment_states effect
      WHERE effect.id = NEW.effect_id
        AND effect.workspace_id = NEW.workspace_id
        AND effect.assignment_id = NEW.assignment_id
        AND effect.state = 'SUBMITTED'
        AND effect.actor_account_id = NEW.actor_account_id
        AND effect.created_at = NEW.created_at
    )
  )
)
OR json_type(NEW.receipt_json, '$') IS NOT 'object'
OR json_extract(NEW.receipt_json, '$.schema') IS NOT NEW.receipt_schema
OR json_extract(NEW.receipt_json, '$.workspaceId') IS NOT NEW.workspace_id
OR json_extract(NEW.receipt_json, '$.assignmentId') IS NOT NEW.assignment_id
OR json_extract(NEW.receipt_json, '$.roundId') IS NOT NEW.round_id
OR json_extract(NEW.receipt_json, '$.rubricVersionId') IS NOT NEW.rubric_version_id
OR json_extract(NEW.receipt_json, '$.submissionRevisionId') IS NOT NEW.submission_revision_id
OR json_extract(NEW.receipt_json, '$.actorAccountId') IS NOT NEW.actor_account_id
OR json_extract(NEW.receipt_json, '$.commandKind') IS NOT NEW.command_kind
OR json_extract(NEW.receipt_json, '$.effectId') IS NOT NEW.effect_id
OR json_extract(NEW.receipt_json, '$.createdAt') IS NOT NEW.created_at
OR NOT (
  (
    NEW.command_kind = 'SAVE_REVIEW'
    AND json_type(NEW.receipt_json, '$.outcome') IS 'object'
    AND (SELECT COUNT(*) FROM json_each(NEW.receipt_json, '$.outcome')) = 2
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.receipt_json, '$.outcome') outcome_key
      WHERE outcome_key.key NOT IN ('reviewRevisionId', 'reviewRevisionNumber')
    )
    AND json_type(NEW.receipt_json, '$.outcome.reviewRevisionId') IS 'text'
    AND json_extract(NEW.receipt_json, '$.outcome.reviewRevisionId') IS NEW.effect_id
    AND json_type(NEW.receipt_json, '$.outcome.reviewRevisionNumber') IS 'integer'
    AND EXISTS (
      SELECT 1
      FROM review_revisions effect
      WHERE effect.id = NEW.effect_id
        AND effect.revision_number =
            json_extract(NEW.receipt_json, '$.outcome.reviewRevisionNumber')
    )
  )
  OR
  (
    NEW.command_kind IN ('CONFLICT_DECLARE', 'CONFLICT_CLEAR', 'SUBMIT_REVIEW')
    AND json_type(NEW.receipt_json, '$.outcome') IS 'object'
    AND (SELECT COUNT(*) FROM json_each(NEW.receipt_json, '$.outcome')) = 1
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.receipt_json, '$.outcome') outcome_key
      WHERE outcome_key.key != 'effectId'
    )
    AND json_type(NEW.receipt_json, '$.outcome.effectId') IS 'text'
    AND json_extract(NEW.receipt_json, '$.outcome.effectId') IS NEW.effect_id
  )
)
BEGIN SELECT RAISE(ABORT, 'review_command_receipts binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_command_receipts_immutable
BEFORE UPDATE ON review_command_receipts
BEGIN SELECT RAISE(ABORT, 'review_command_receipts is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_command_receipts_no_delete
BEFORE DELETE ON review_command_receipts
BEGIN SELECT RAISE(ABORT, 'review_command_receipts is immutable'); END;
`;

// V6 replaces the V5 blind-artifact insertion guard at the trusted SQLite boundary. The V5
// packet remains literal migration history so an accepted V5 database can be identified exactly.
export const V6_DDL = `
DROP TRIGGER IF EXISTS trg_review_blind_artifacts_guard;

CREATE TRIGGER IF NOT EXISTS trg_review_blind_artifacts_guard
BEFORE INSERT ON review_blind_artifacts
WHEN length(CAST(NEW.rubric_semantics_fingerprint AS BLOB)) != 64
OR NEW.rubric_semantics_fingerprint GLOB '*[^0-9a-f]*'
OR length(CAST(NEW.submission_revision_fingerprint AS BLOB)) != 64
OR length(CAST(NEW.form_document_fingerprint AS BLOB)) != 64
OR length(CAST(NEW.fingerprint AS BLOB)) != 64
OR length(CAST(NEW.request_fingerprint AS BLOB)) != 64
OR NEW.issuer_role NOT IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
OR NOT EXISTS (
  SELECT 1
  FROM review_assignments assignment
  JOIN review_rounds round ON round.id = assignment.round_id
  JOIN rubric_versions rubric ON rubric.id = assignment.rubric_version_id
  JOIN review_rubric_semantics semantics ON semantics.id = NEW.rubric_semantics_id
  JOIN submissions submission ON submission.id = assignment.submission_id
  JOIN submission_revisions revision ON revision.id = assignment.submission_revision_id
  JOIN form_versions form ON form.id = revision.form_version_id
  JOIN rule_versions rule ON rule.id = revision.rule_version_id
  JOIN accounts issuer ON issuer.id = NEW.issued_by_account_id
  WHERE assignment.id = NEW.assignment_id
    AND assignment.workspace_id = NEW.workspace_id
    AND assignment.created_at = NEW.assignment_created_at
    AND assignment.rubric_version_id = NEW.rubric_version_id
    AND assignment.submission_id = NEW.submission_id
    AND assignment.submission_revision_id = NEW.submission_revision_id
    AND round.workspace_id = NEW.workspace_id
    AND rubric.workspace_id = NEW.workspace_id
    AND rubric.round_id = assignment.round_id
    AND semantics.workspace_id = NEW.workspace_id
    AND semantics.round_id = assignment.round_id
    AND semantics.rubric_version_id = NEW.rubric_version_id
    AND semantics.fingerprint = NEW.rubric_semantics_fingerprint
    AND submission.workspace_id = NEW.workspace_id
    AND submission.state = 'SUBMITTED'
    AND submission.current_revision_id = NEW.submission_revision_id
    AND revision.workspace_id = NEW.workspace_id
    AND revision.submission_id = NEW.submission_id
    AND revision.revision_number = NEW.submission_revision_number
    AND revision.revision_schema = NEW.submission_revision_schema
    AND revision.fingerprint_algorithm = NEW.submission_revision_fingerprint_algorithm
    AND revision.fingerprint = NEW.submission_revision_fingerprint
    AND revision.created_at = NEW.submission_revision_created_at
    AND revision.form_document_schema = NEW.form_document_schema
    AND revision.form_version_id = NEW.form_version_id
    AND revision.rule_version_id = NEW.rule_version_id
    AND revision.form_document_fingerprint = NEW.form_document_fingerprint
    AND form.workspace_id = NEW.workspace_id
    AND form.document_schema = NEW.form_document_schema
    AND form.rule_version_id = NEW.rule_version_id
    AND rule.workspace_id = NEW.workspace_id
    AND rule.id = NEW.rule_version_id
    AND rule.form_definition_id = form.form_definition_id
    AND issuer.workspace_id = NEW.workspace_id
    AND issuer.role = NEW.issuer_role
    AND issuer.role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
    AND (
      SELECT state
      FROM review_round_states
      WHERE round_id = assignment.round_id
      ORDER BY sequence_number DESC
      LIMIT 1
    ) IN ('DRAFT', 'OPEN')
    AND (
      SELECT state
      FROM review_assignment_states
      WHERE assignment_id = NEW.assignment_id
      ORDER BY sequence_number DESC
      LIMIT 1
    ) IN ('ASSIGNED', 'IN_PROGRESS')
    AND (
      (
        NEW.conflict_status_at_issuance = 'NONE'
        AND NEW.conflict_sequence_at_issuance = 0
        AND NOT EXISTS (
          SELECT 1 FROM review_conflict_dispositions
          WHERE assignment_id = NEW.assignment_id
        )
      )
      OR EXISTS (
        SELECT 1
        FROM review_conflict_dispositions disposition
        WHERE disposition.assignment_id = NEW.assignment_id
          AND disposition.sequence_number = NEW.conflict_sequence_at_issuance
          AND disposition.sequence_number = (
            SELECT MAX(latest.sequence_number)
            FROM review_conflict_dispositions latest
            WHERE latest.assignment_id = NEW.assignment_id
          )
          AND (
            (NEW.conflict_status_at_issuance = 'CLEARED' AND disposition.action = 'CLEAR')
            OR (NEW.conflict_status_at_issuance = 'WAIVED' AND disposition.action = 'WAIVE')
          )
      )
    )
)
OR json_type(NEW.artifact_json, '$') IS NOT 'object'
OR json_extract(NEW.artifact_json, '$.schema') IS NOT NEW.artifact_schema
OR json_extract(NEW.artifact_json, '$.version') IS NOT NEW.artifact_version
OR json_extract(NEW.artifact_json, '$.workspaceId') IS NOT NEW.workspace_id
OR json_extract(NEW.artifact_json, '$.assignmentId') IS NOT NEW.assignment_id
OR json_extract(NEW.artifact_json, '$.assignmentCreatedAt') IS NOT NEW.assignment_created_at
OR json_extract(NEW.artifact_json, '$.rubricVersionId') IS NOT NEW.rubric_version_id
OR json_extract(NEW.artifact_json, '$.rubricSemanticsId') IS NOT NEW.rubric_semantics_id
OR json_extract(NEW.artifact_json, '$.rubricSemanticsFingerprint') IS NOT NEW.rubric_semantics_fingerprint
OR json_extract(NEW.artifact_json, '$.submissionId') IS NOT NEW.submission_id
OR json_extract(NEW.artifact_json, '$.submissionRevision.id') IS NOT NEW.submission_revision_id
OR json_extract(NEW.artifact_json, '$.submissionRevision.number') IS NOT NEW.submission_revision_number
OR json_extract(NEW.artifact_json, '$.submissionRevision.schema') IS NOT NEW.submission_revision_schema
OR json_extract(NEW.artifact_json, '$.submissionRevision.fingerprint') IS NOT NEW.submission_revision_fingerprint
OR json_extract(NEW.artifact_json, '$.submissionRevision.createdAt') IS NOT NEW.submission_revision_created_at
OR json_extract(NEW.artifact_json, '$.submissionRevision.formDocumentSchema') IS NOT NEW.form_document_schema
OR json_extract(NEW.artifact_json, '$.submissionRevision.formVersionId') IS NOT NEW.form_version_id
OR json_extract(NEW.artifact_json, '$.submissionRevision.ruleVersionId') IS NOT NEW.rule_version_id
OR json_extract(NEW.artifact_json, '$.submissionRevision.formDocumentFingerprint') IS NOT NEW.form_document_fingerprint
OR json_extract(NEW.artifact_json, '$.disclosureStage') IS NOT NEW.disclosure_stage
OR json_extract(NEW.artifact_json, '$.conflictAtIssuance.status') IS NOT NEW.conflict_status_at_issuance
OR json_extract(NEW.artifact_json, '$.conflictAtIssuance.sequenceNumber') IS NOT NEW.conflict_sequence_at_issuance
OR json_extract(NEW.artifact_json, '$.attestation') IS NOT NEW.blind_safety_attestation
OR json_extract(NEW.artifact_json, '$.issuer.accountId') IS NOT NEW.issued_by_account_id
OR json_extract(NEW.artifact_json, '$.issuer.role') IS NOT NEW.issuer_role
OR json_extract(NEW.artifact_json, '$.issuer.authority') IS NOT NEW.issuer_authority
OR json_extract(NEW.artifact_json, '$.issuedAt') IS NOT NEW.issued_at
BEGIN SELECT RAISE(ABORT, 'review_blind_artifacts binding mismatch'); END;
`;

// V7 gives verification issuance an explicit durable authority order. The sequence is part of
// the immutable verification evidence itself, is unique inside the exact tenant/call/email
// scope, and must be allocated without gaps. V6 and earlier remain literal migration history.
export const V7_DDL = `
CREATE TRIGGER IF NOT EXISTS trg_cfp_email_verifications_immutable BEFORE UPDATE ON cfp_email_verifications
BEGIN SELECT RAISE(ABORT, 'cfp_email_verifications is immutable'); END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cfp_email_verifications_scope_sequence
ON cfp_email_verifications(workspace_id, call_id, email, issuance_sequence);

CREATE TRIGGER IF NOT EXISTS trg_cfp_email_verifications_issuance_sequence_guard
BEFORE INSERT ON cfp_email_verifications
WHEN NEW.issuance_sequence IS NOT COALESCE(
  (
    SELECT MAX(prior.issuance_sequence) + 1
    FROM cfp_email_verifications prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.call_id = NEW.call_id
      AND prior.email = NEW.email
  ),
  1
)
BEGIN SELECT RAISE(ABORT, 'cfp_email_verifications issuance sequence mismatch'); END;
`;

// V8 is the additive PD-01 foundation packet. These records deliberately stop before selection
// context/slates: P1 lineage, P2 advocacy, and P3 typed capacity are independently queryable
// truth families and do not infer or rewrite historical CFP/review rows.
export const V8_DDL = `
CREATE TABLE IF NOT EXISTS proposal_lineages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  originating_submission_id TEXT REFERENCES submissions(id),
  originating_submission_revision_id TEXT REFERENCES submission_revisions(id),
  display_projection_json TEXT NOT NULL
    CHECK (typeof(display_projection_json) = 'text'
      AND json_valid(display_projection_json) = 1
      AND length(CAST(display_projection_json AS BLOB)) <= 524288),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (workspace_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS submission_derivations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  relationship_type TEXT NOT NULL CHECK (relationship_type IN
    ('RESUBMISSION_OF', 'CARRIED_FORWARD_FROM', 'COMBINED_FROM', 'SPLIT_FROM', 'INVITED_FROM_NEAR_MISS')),
  source_submission_id TEXT NOT NULL REFERENCES submissions(id),
  source_submission_revision_id TEXT NOT NULL REFERENCES submission_revisions(id),
  target_submission_id TEXT REFERENCES submissions(id),
  target_submission_revision_id TEXT REFERENCES submission_revisions(id),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 4096),
  guidance_request_id TEXT REFERENCES resubmission_requests(id),
  guidance_reference TEXT,
  created_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK ((target_submission_id IS NULL) = (target_submission_revision_id IS NULL)),
  UNIQUE (workspace_id, fingerprint)
) STRICT;

CREATE TABLE IF NOT EXISTS resubmission_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_submission_id TEXT NOT NULL REFERENCES submissions(id),
  source_submission_revision_id TEXT NOT NULL REFERENCES submission_revisions(id),
  target_call_id TEXT REFERENCES calls(id),
  guidance_version TEXT NOT NULL CHECK (length(CAST(guidance_version AS BLOB)) BETWEEN 1 AND 128),
  guidance_json TEXT NOT NULL
    CHECK (typeof(guidance_json) = 'text' AND json_valid(guidance_json) = 1
      AND length(CAST(guidance_json AS BLOB)) <= 524288),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (workspace_id, fingerprint)
) STRICT;

CREATE TABLE IF NOT EXISTS recommendation_sets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  reviewer_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, reviewer_account_id)
) STRICT;

CREATE TABLE IF NOT EXISTS recommendation_set_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  recommendation_set_id TEXT NOT NULL,
  reviewer_account_id TEXT NOT NULL REFERENCES accounts(id),
  version_number INTEGER NOT NULL CHECK (typeof(version_number) = 'integer' AND version_number >= 1),
  eligibility_snapshot_json TEXT NOT NULL
    CHECK (typeof(eligibility_snapshot_json) = 'text' AND json_valid(eligibility_snapshot_json) = 1
      AND length(CAST(eligibility_snapshot_json AS BLOB)) <= 524288),
  eligibility_fingerprint TEXT NOT NULL CHECK (length(eligibility_fingerprint) = 64 AND eligibility_fingerprint NOT GLOB '*[^0-9a-f]*'),
  maximum_entries INTEGER NOT NULL CHECK (typeof(maximum_entries) = 'integer' AND maximum_entries >= 1),
  policy_version_id TEXT NOT NULL CHECK (length(CAST(policy_version_id AS BLOB)) BETWEEN 1 AND 128),
  visibility_version_id TEXT NOT NULL CHECK (length(CAST(visibility_version_id AS BLOB)) BETWEEN 1 AND 128),
  blindness_version_id TEXT NOT NULL CHECK (length(CAST(blindness_version_id AS BLOB)) BETWEEN 1 AND 128),
  selection_context_reference TEXT NOT NULL CHECK (length(CAST(selection_context_reference AS BLOB)) BETWEEN 1 AND 256),
  selection_context_fingerprint TEXT NOT NULL CHECK (length(selection_context_fingerprint) = 64 AND selection_context_fingerprint NOT GLOB '*[^0-9a-f]*'),
  content_fingerprint TEXT CHECK (content_fingerprint IS NULL OR (length(content_fingerprint) = 64 AND content_fingerprint NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  sealed_at TEXT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, id, content_fingerprint),
  UNIQUE (workspace_id, event_id, recommendation_set_id, version_number),
  FOREIGN KEY (workspace_id, event_id, recommendation_set_id)
    REFERENCES recommendation_sets(workspace_id, event_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS recommendation_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  recommendation_set_version_id TEXT NOT NULL,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  submission_revision_id TEXT NOT NULL REFERENCES submission_revisions(id),
  stance TEXT NOT NULL CHECK (stance IN ('PROMOTE', 'STRONGLY_PROMOTE', 'OPPOSE', 'NO_POSITION')),
  rank INTEGER CHECK (rank IS NULL OR (typeof(rank) = 'integer' AND rank >= 1)),
  strength INTEGER CHECK (strength IS NULL OR (typeof(strength) = 'integer' AND strength BETWEEN 0 AND 100)),
  rationale TEXT CHECK (rationale IS NULL OR length(CAST(rationale AS BLOB)) <= 4096),
  follow_up_willingness INTEGER CHECK (follow_up_willingness IS NULL OR follow_up_willingness IN (0, 1)),
  evidence_json TEXT
    CHECK (evidence_json IS NULL OR (typeof(evidence_json) = 'text' AND json_valid(evidence_json) = 1
      AND length(CAST(evidence_json AS BLOB)) <= 524288)),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (recommendation_set_version_id, submission_revision_id),
  UNIQUE (recommendation_set_version_id, rank),
  FOREIGN KEY (workspace_id, event_id, recommendation_set_version_id)
    REFERENCES recommendation_set_versions(workspace_id, event_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS program_capacity_pools (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  unit_kind TEXT NOT NULL CHECK (length(CAST(unit_kind AS BLOB)) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, event_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS program_capacity_pool_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  pool_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (typeof(version_number) = 'integer' AND version_number >= 1),
  unit_kind TEXT NOT NULL CHECK (length(CAST(unit_kind AS BLOB)) BETWEEN 1 AND 128),
  capacity INTEGER NOT NULL CHECK (typeof(capacity) = 'integer' AND capacity >= 0),
  scope_json TEXT NOT NULL CHECK (typeof(scope_json) = 'text' AND json_valid(scope_json) = 1
    AND length(CAST(scope_json AS BLOB)) <= 524288),
  eligibility_json TEXT NOT NULL CHECK (typeof(eligibility_json) = 'text' AND json_valid(eligibility_json) = 1
    AND length(CAST(eligibility_json AS BLOB)) <= 524288),
  reserved_for_json TEXT NOT NULL CHECK (typeof(reserved_for_json) = 'text' AND json_valid(reserved_for_json) = 1
    AND length(CAST(reserved_for_json AS BLOB)) <= 524288),
  release_policy_json TEXT NOT NULL CHECK (typeof(release_policy_json) = 'text' AND json_valid(release_policy_json) = 1
    AND length(CAST(release_policy_json AS BLOB)) <= 524288),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, event_id, pool_id, version_number),
  UNIQUE (workspace_id, event_id, pool_id, id),
  FOREIGN KEY (workspace_id, event_id, pool_id) REFERENCES program_capacity_pools(workspace_id, event_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS capacity_transfer_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  sequence_number INTEGER NOT NULL CHECK (typeof(sequence_number) = 'integer' AND sequence_number >= 1),
  source_pool_id TEXT NOT NULL,
  source_pool_version_id TEXT NOT NULL,
  destination_pool_id TEXT NOT NULL,
  destination_pool_version_id TEXT NOT NULL,
  unit_kind TEXT NOT NULL CHECK (length(CAST(unit_kind AS BLOB)) BETWEEN 1 AND 128),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
  source_before INTEGER NOT NULL CHECK (typeof(source_before) = 'integer' AND source_before >= 0),
  source_after INTEGER NOT NULL CHECK (typeof(source_after) = 'integer' AND source_after >= 0),
  destination_before INTEGER NOT NULL CHECK (typeof(destination_before) = 'integer' AND destination_before >= 0),
  destination_after INTEGER NOT NULL CHECK (typeof(destination_after) = 'integer' AND destination_after >= 0),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 4096),
  approval_reference TEXT NOT NULL CHECK (length(CAST(approval_reference AS BLOB)) BETWEEN 1 AND 256),
  decided_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, event_id, id),
  UNIQUE (workspace_id, actor_account_id, idempotency_key),
  UNIQUE (workspace_id, event_id, sequence_number),
  UNIQUE (workspace_id, fingerprint),
  FOREIGN KEY (workspace_id, event_id, source_pool_id, source_pool_version_id)
    REFERENCES program_capacity_pool_versions(workspace_id, event_id, pool_id, id),
  FOREIGN KEY (workspace_id, event_id, destination_pool_id, destination_pool_version_id)
    REFERENCES program_capacity_pool_versions(workspace_id, event_id, pool_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS capacity_transfer_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  decision_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  source_pool_id TEXT NOT NULL,
  source_pool_version_id TEXT NOT NULL,
  destination_pool_id TEXT NOT NULL,
  destination_pool_version_id TEXT NOT NULL,
  unit_kind TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  source_before INTEGER NOT NULL,
  source_after INTEGER NOT NULL,
  destination_before INTEGER NOT NULL,
  destination_after INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (workspace_id, decision_id),
  UNIQUE (workspace_id, fingerprint),
  FOREIGN KEY (workspace_id, event_id, decision_id) REFERENCES capacity_transfer_decisions(workspace_id, event_id, id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_revisions_workspace_id
  ON submission_revisions(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_workspace_id
  ON submissions(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_workspace_id
  ON calls(workspace_id, id);
CREATE INDEX IF NOT EXISTS idx_submission_derivations_source
  ON submission_derivations(workspace_id, source_submission_id, source_submission_revision_id);
CREATE INDEX IF NOT EXISTS idx_recommendation_versions_set
  ON recommendation_set_versions(workspace_id, event_id, recommendation_set_id, version_number);
CREATE INDEX IF NOT EXISTS idx_recommendation_entries_revision
  ON recommendation_entries(workspace_id, event_id, submission_revision_id);
CREATE INDEX IF NOT EXISTS idx_capacity_pool_versions_pool
  ON program_capacity_pool_versions(workspace_id, event_id, pool_id, version_number);
CREATE INDEX IF NOT EXISTS idx_capacity_transfer_receipts_event
  ON capacity_transfer_receipts(workspace_id, event_id, sequence_number);

CREATE TRIGGER IF NOT EXISTS trg_proposal_lineages_guard BEFORE INSERT ON proposal_lineages
WHEN (NEW.originating_submission_id IS NULL) <> (NEW.originating_submission_revision_id IS NULL)
OR (NEW.originating_submission_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM submissions s JOIN submission_revisions r ON r.id = NEW.originating_submission_revision_id
  WHERE s.id = NEW.originating_submission_id AND s.workspace_id = NEW.workspace_id
    AND r.workspace_id = NEW.workspace_id AND r.submission_id = s.id
))
OR sympose_pd01_canonical_json(NEW.display_projection_json) IS NOT NEW.display_projection_json
OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = NEW.created_by_account_id AND a.workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'proposal_lineages binding mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_proposal_lineages_identity_immutable BEFORE UPDATE ON proposal_lineages
BEGIN SELECT RAISE(ABORT, 'proposal_lineages is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_proposal_lineages_no_delete BEFORE DELETE ON proposal_lineages
BEGIN SELECT RAISE(ABORT, 'proposal_lineages is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_submission_derivations_guard BEFORE INSERT ON submission_derivations
WHEN NOT EXISTS (
  SELECT 1 FROM submissions s JOIN submission_revisions r ON r.id = NEW.source_submission_revision_id
  WHERE s.id = NEW.source_submission_id AND s.workspace_id = NEW.workspace_id
    AND r.workspace_id = NEW.workspace_id AND r.submission_id = s.id
)
OR (NEW.target_submission_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM submissions s JOIN submission_revisions r ON r.id = NEW.target_submission_revision_id
  WHERE s.id = NEW.target_submission_id AND s.workspace_id = NEW.workspace_id
    AND r.workspace_id = NEW.workspace_id AND r.submission_id = s.id
))
OR NEW.source_submission_id IS NEW.target_submission_id
OR (NEW.guidance_request_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM resubmission_requests q WHERE q.id = NEW.guidance_request_id AND q.workspace_id = NEW.workspace_id
    AND q.source_submission_id = NEW.source_submission_id
    AND q.source_submission_revision_id = NEW.source_submission_revision_id
))
OR sympose_pd01_fingerprint(json_object(
  'schema', 'pd01-submission-derivation/v1', 'workspaceId', NEW.workspace_id,
  'relationshipType', NEW.relationship_type, 'sourceSubmissionId', NEW.source_submission_id,
  'sourceSubmissionRevisionId', NEW.source_submission_revision_id,
  'targetSubmissionId', NEW.target_submission_id, 'targetSubmissionRevisionId', NEW.target_submission_revision_id,
  'actorAccountId', NEW.actor_account_id, 'reason', NEW.reason,
  'guidanceRequestId', NEW.guidance_request_id, 'guidanceReference', NEW.guidance_reference,
  'createdAt', NEW.created_at)) IS NOT NEW.fingerprint
OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = NEW.actor_account_id AND a.workspace_id = NEW.workspace_id)
OR EXISTS (WITH RECURSIVE chain(id) AS (
  SELECT target_submission_id FROM submission_derivations WHERE source_submission_id = NEW.target_submission_id
  UNION SELECT d.target_submission_id FROM submission_derivations d JOIN chain c ON d.source_submission_id = c.id
) SELECT 1 FROM chain WHERE id = NEW.source_submission_id)
BEGIN SELECT RAISE(ABORT, 'submission_derivations binding or cycle mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_submission_derivations_immutable BEFORE UPDATE ON submission_derivations
BEGIN SELECT RAISE(ABORT, 'submission_derivations is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_submission_derivations_no_delete BEFORE DELETE ON submission_derivations
BEGIN SELECT RAISE(ABORT, 'submission_derivations is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_resubmission_requests_guard BEFORE INSERT ON resubmission_requests
WHEN NOT EXISTS (
  SELECT 1 FROM submissions s JOIN submission_revisions r ON r.id = NEW.source_submission_revision_id
  WHERE s.id = NEW.source_submission_id AND s.workspace_id = NEW.workspace_id
    AND r.workspace_id = NEW.workspace_id AND r.submission_id = s.id
)
OR (NEW.target_call_id IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM calls c WHERE c.id = NEW.target_call_id AND c.workspace_id = NEW.workspace_id))
OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = NEW.created_by_account_id AND a.workspace_id = NEW.workspace_id)
OR sympose_pd01_canonical_json(NEW.guidance_json) IS NOT NEW.guidance_json
OR sympose_pd01_fingerprint(json_object(
  'schema', 'pd01-resubmission-request/v1', 'workspaceId', NEW.workspace_id,
  'sourceSubmissionId', NEW.source_submission_id, 'sourceSubmissionRevisionId', NEW.source_submission_revision_id,
  'targetCallId', NEW.target_call_id, 'guidanceVersion', NEW.guidance_version,
  'guidance', json(NEW.guidance_json), 'createdByAccountId', NEW.created_by_account_id,
  'createdAt', NEW.created_at, 'expiresAt', NEW.expires_at)) IS NOT NEW.fingerprint
BEGIN SELECT RAISE(ABORT, 'resubmission_requests binding mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_resubmission_requests_immutable BEFORE UPDATE ON resubmission_requests
BEGIN SELECT RAISE(ABORT, 'resubmission_requests is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_resubmission_requests_no_delete BEFORE DELETE ON resubmission_requests
BEGIN SELECT RAISE(ABORT, 'resubmission_requests is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_submissions_lineage_guard BEFORE INSERT ON submissions
WHEN NEW.lineage_id IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM proposal_lineages l WHERE l.id = NEW.lineage_id AND l.workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'submissions lineage workspace mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_submissions_lineage_update_guard BEFORE UPDATE OF lineage_id ON submissions
WHEN NEW.lineage_id IS NOT OLD.lineage_id AND OLD.lineage_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'submissions lineage is write-once'); END;
CREATE TRIGGER IF NOT EXISTS trg_submissions_lineage_workspace_update_guard BEFORE UPDATE OF lineage_id ON submissions
WHEN OLD.lineage_id IS NULL AND NEW.lineage_id IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM proposal_lineages l WHERE l.id = NEW.lineage_id AND l.workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'submissions lineage workspace mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_recommendation_sets_guard BEFORE INSERT ON recommendation_sets
WHEN NOT EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id)
OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = NEW.reviewer_account_id AND a.workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'recommendation_sets workspace mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_sets_identity_immutable BEFORE UPDATE ON recommendation_sets
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.event_id IS NOT OLD.event_id
  OR NEW.reviewer_account_id IS NOT OLD.reviewer_account_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'recommendation_sets identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_set_versions_guard BEFORE INSERT ON recommendation_set_versions
WHEN NOT EXISTS (SELECT 1 FROM recommendation_sets s WHERE s.workspace_id = NEW.workspace_id
  AND s.event_id = NEW.event_id AND s.id = NEW.recommendation_set_id AND s.reviewer_account_id = NEW.reviewer_account_id)
OR NEW.version_number IS NOT COALESCE((SELECT MAX(version_number) + 1 FROM recommendation_set_versions
  WHERE workspace_id = NEW.workspace_id AND recommendation_set_id = NEW.recommendation_set_id), 1)
OR NEW.submitted_at IS NOT NULL OR NEW.sealed_at IS NOT NULL OR NEW.content_fingerprint IS NOT NULL
OR sympose_pd01_canonical_json(NEW.eligibility_snapshot_json) IS NOT NEW.eligibility_snapshot_json
OR NEW.eligibility_fingerprint IS NOT sympose_pd01_fingerprint(NEW.eligibility_snapshot_json)
OR NEW.selection_context_fingerprint IS NOT sympose_pd01_fingerprint(json_object(
  'schema', 'pd01-selection-context/v1', 'workspaceId', NEW.workspace_id, 'eventId', NEW.event_id,
  'recommendationSetId', NEW.recommendation_set_id, 'reviewerAccountId', NEW.reviewer_account_id,
  'reference', NEW.selection_context_reference))
BEGIN SELECT RAISE(ABORT, 'recommendation_set_versions binding, fingerprint, or sequence mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_set_versions_finalize_or_immutable BEFORE UPDATE ON recommendation_set_versions
WHEN NOT (
  NEW.id IS OLD.id AND NEW.workspace_id IS OLD.workspace_id AND NEW.event_id IS OLD.event_id
  AND NEW.recommendation_set_id IS OLD.recommendation_set_id AND NEW.reviewer_account_id IS OLD.reviewer_account_id
  AND NEW.version_number IS OLD.version_number AND NEW.eligibility_snapshot_json IS OLD.eligibility_snapshot_json
  AND NEW.eligibility_fingerprint IS OLD.eligibility_fingerprint AND NEW.maximum_entries IS OLD.maximum_entries
  AND NEW.policy_version_id IS OLD.policy_version_id AND NEW.visibility_version_id IS OLD.visibility_version_id
  AND NEW.blindness_version_id IS OLD.blindness_version_id
  AND NEW.selection_context_reference IS OLD.selection_context_reference
  AND NEW.selection_context_fingerprint IS OLD.selection_context_fingerprint
  AND NEW.created_at IS OLD.created_at AND OLD.submitted_at IS NULL AND OLD.sealed_at IS NULL
  AND NEW.submitted_at IS NOT NULL AND NEW.sealed_at IS NOT NULL
  AND NEW.submitted_at >= NEW.created_at AND NEW.sealed_at >= NEW.submitted_at
  AND NEW.content_fingerprint IS NOT NULL
  AND length(CAST(json_object(
    'schema', 'pd01-recommendation-ballot/v1', 'workspaceId', NEW.workspace_id,
    'eventId', NEW.event_id, 'recommendationSetId', NEW.recommendation_set_id,
    'versionNumber', NEW.version_number, 'reviewerAccountId', NEW.reviewer_account_id,
    'eligibilityFingerprint', NEW.eligibility_fingerprint,
    'selectionContextReference', NEW.selection_context_reference,
    'selectionContextFingerprint', NEW.selection_context_fingerprint,
    'maximumEntries', NEW.maximum_entries, 'policyVersionId', NEW.policy_version_id,
    'visibilityVersionId', NEW.visibility_version_id, 'blindnessVersionId', NEW.blindness_version_id,
    'entries', (SELECT json_group_array(json_object(
      'id', entry.id, 'submissionId', entry.submission_id, 'submissionRevisionId', entry.submission_revision_id,
      'stance', entry.stance, 'rank', entry.rank, 'strength', entry.strength, 'rationale', entry.rationale,
      'followUpWillingness', entry.follow_up_willingness, 'evidence', json(entry.evidence_json)))
      FROM (SELECT * FROM recommendation_entries WHERE recommendation_set_version_id = NEW.id
            ORDER BY rank IS NULL, rank, id) entry)) AS BLOB)) <= 524288
  AND sympose_pd01_fingerprint(json_object(
    'schema', 'pd01-recommendation-ballot/v1', 'workspaceId', NEW.workspace_id,
    'eventId', NEW.event_id, 'recommendationSetId', NEW.recommendation_set_id,
    'versionNumber', NEW.version_number, 'reviewerAccountId', NEW.reviewer_account_id,
    'eligibilityFingerprint', NEW.eligibility_fingerprint,
    'selectionContextReference', NEW.selection_context_reference,
    'selectionContextFingerprint', NEW.selection_context_fingerprint,
    'maximumEntries', NEW.maximum_entries, 'policyVersionId', NEW.policy_version_id,
    'visibilityVersionId', NEW.visibility_version_id, 'blindnessVersionId', NEW.blindness_version_id,
    'entries', (SELECT json_group_array(json_object(
      'id', entry.id, 'submissionId', entry.submission_id, 'submissionRevisionId', entry.submission_revision_id,
      'stance', entry.stance, 'rank', entry.rank, 'strength', entry.strength, 'rationale', entry.rationale,
      'followUpWillingness', entry.follow_up_willingness, 'evidence', json(entry.evidence_json)))
      FROM (SELECT * FROM recommendation_entries WHERE recommendation_set_version_id = NEW.id
            ORDER BY rank IS NULL, rank, id) entry))) IS NOT NULL
  AND NEW.content_fingerprint IS sympose_pd01_fingerprint(json_object(
    'schema', 'pd01-recommendation-ballot/v1', 'workspaceId', NEW.workspace_id,
    'eventId', NEW.event_id, 'recommendationSetId', NEW.recommendation_set_id,
    'versionNumber', NEW.version_number, 'reviewerAccountId', NEW.reviewer_account_id,
    'eligibilityFingerprint', NEW.eligibility_fingerprint,
    'selectionContextReference', NEW.selection_context_reference,
    'selectionContextFingerprint', NEW.selection_context_fingerprint,
    'maximumEntries', NEW.maximum_entries, 'policyVersionId', NEW.policy_version_id,
    'visibilityVersionId', NEW.visibility_version_id, 'blindnessVersionId', NEW.blindness_version_id,
    'entries', (SELECT json_group_array(json_object(
      'id', entry.id, 'submissionId', entry.submission_id, 'submissionRevisionId', entry.submission_revision_id,
      'stance', entry.stance, 'rank', entry.rank, 'strength', entry.strength, 'rationale', entry.rationale,
      'followUpWillingness', entry.follow_up_willingness, 'evidence', json(entry.evidence_json)))
      FROM (SELECT * FROM recommendation_entries WHERE recommendation_set_version_id = NEW.id
            ORDER BY rank IS NULL, rank, id) entry)))
)
BEGIN SELECT RAISE(ABORT, 'recommendation_set_versions is immutable or finalization mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_set_versions_no_delete BEFORE DELETE ON recommendation_set_versions
BEGIN SELECT RAISE(ABORT, 'recommendation_set_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_entries_guard BEFORE INSERT ON recommendation_entries
WHEN NOT EXISTS (SELECT 1 FROM recommendation_set_versions v WHERE v.workspace_id = NEW.workspace_id
  AND v.event_id = NEW.event_id AND v.id = NEW.recommendation_set_version_id AND v.sealed_at IS NULL
  AND (SELECT COUNT(*) FROM recommendation_entries existing
       WHERE existing.recommendation_set_version_id = NEW.recommendation_set_version_id) < v.maximum_entries)
OR NOT EXISTS (SELECT 1 FROM submissions s JOIN submission_revisions r ON r.id = NEW.submission_revision_id
  WHERE s.id = NEW.submission_id AND s.workspace_id = NEW.workspace_id AND s.event_id = NEW.event_id
    AND r.workspace_id = NEW.workspace_id AND r.submission_id = s.id)
OR (NEW.evidence_json IS NOT NULL
    AND sympose_pd01_canonical_json(NEW.evidence_json) IS NOT NEW.evidence_json)
OR (NEW.rank IS NOT NULL AND NEW.rank > (SELECT maximum_entries FROM recommendation_set_versions WHERE id = NEW.RECOMMENDATION_SET_VERSION_ID))
BEGIN SELECT RAISE(ABORT, 'recommendation_entries binding mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_entries_immutable BEFORE UPDATE ON recommendation_entries
BEGIN SELECT RAISE(ABORT, 'recommendation_entries is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_entries_no_delete BEFORE DELETE ON recommendation_entries
BEGIN SELECT RAISE(ABORT, 'recommendation_entries is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_program_capacity_pools_guard BEFORE INSERT ON program_capacity_pools
WHEN NOT EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'program_capacity_pools workspace mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_program_capacity_pools_identity_immutable BEFORE UPDATE ON program_capacity_pools
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.event_id IS NOT OLD.event_id
  OR NEW.unit_kind IS NOT OLD.unit_kind OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'program_capacity_pools identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_program_capacity_pool_versions_guard BEFORE INSERT ON program_capacity_pool_versions
WHEN NOT EXISTS (SELECT 1 FROM program_capacity_pools p WHERE p.workspace_id = NEW.workspace_id
  AND p.event_id = NEW.event_id AND p.id = NEW.pool_id AND p.unit_kind = NEW.unit_kind)
OR NEW.version_number IS NOT COALESCE((SELECT MAX(version_number) + 1 FROM program_capacity_pool_versions
  WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id AND pool_id = NEW.pool_id), 1)
OR sympose_pd01_canonical_json(NEW.scope_json) IS NOT NEW.scope_json
OR sympose_pd01_canonical_json(NEW.eligibility_json) IS NOT NEW.eligibility_json
OR sympose_pd01_canonical_json(NEW.reserved_for_json) IS NOT NEW.reserved_for_json
OR sympose_pd01_canonical_json(NEW.release_policy_json) IS NOT NEW.release_policy_json
OR sympose_pd01_fingerprint(json_object(
  'schema', 'pd01-capacity-pool-version/v1', 'workspaceId', NEW.workspace_id, 'eventId', NEW.event_id,
  'poolId', NEW.pool_id, 'versionNumber', NEW.version_number, 'unitKind', NEW.unit_kind,
  'capacity', NEW.capacity, 'scope', json(NEW.scope_json), 'eligibility', json(NEW.eligibility_json),
  'reservedFor', json(NEW.reserved_for_json), 'releasePolicy', json(NEW.release_policy_json),
  'effectiveFrom', NEW.effective_from, 'effectiveTo', NEW.effective_to, 'createdAt', NEW.created_at)) IS NOT NEW.fingerprint
BEGIN SELECT RAISE(ABORT, 'program_capacity_pool_versions binding or sequence mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_program_capacity_pool_versions_immutable BEFORE UPDATE ON program_capacity_pool_versions
BEGIN SELECT RAISE(ABORT, 'program_capacity_pool_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_program_capacity_pool_versions_no_delete BEFORE DELETE ON program_capacity_pool_versions
BEGIN SELECT RAISE(ABORT, 'program_capacity_pool_versions is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_capacity_transfer_decisions_guard BEFORE INSERT ON capacity_transfer_decisions
WHEN NEW.source_pool_id IS NEW.destination_pool_id
OR NEW.source_after IS NOT NEW.source_before - NEW.quantity
OR NEW.destination_after IS NOT NEW.destination_before + NEW.quantity
OR NEW.sequence_number IS NOT COALESCE((SELECT MAX(sequence_number) + 1 FROM capacity_transfer_decisions
  WHERE workspace_id = NEW.workspace_id AND event_id = NEW.event_id), 1)
OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = NEW.actor_account_id AND a.workspace_id = NEW.workspace_id)
OR NOT EXISTS (SELECT 1 FROM program_capacity_pool_versions p WHERE p.workspace_id = NEW.workspace_id
  AND p.event_id = NEW.event_id AND p.pool_id = NEW.source_pool_id AND p.id = NEW.source_pool_version_id
  AND p.unit_kind = NEW.unit_kind)
OR NOT EXISTS (SELECT 1 FROM program_capacity_pool_versions p WHERE p.workspace_id = NEW.workspace_id
  AND p.event_id = NEW.event_id AND p.pool_id = NEW.destination_pool_id AND p.id = NEW.destination_pool_version_id
  AND p.unit_kind = NEW.unit_kind)
OR EXISTS (
  SELECT 1 FROM capacity_transfer_decisions prior
  WHERE prior.workspace_id = NEW.workspace_id AND prior.event_id = NEW.event_id
    AND prior.sequence_number < NEW.sequence_number
    AND ((prior.source_pool_id = NEW.source_pool_id AND prior.source_pool_version_id IS NOT NEW.source_pool_version_id)
      OR (prior.destination_pool_id = NEW.source_pool_id AND prior.destination_pool_version_id IS NOT NEW.source_pool_version_id))
)
OR EXISTS (
  SELECT 1 FROM capacity_transfer_decisions prior
  WHERE prior.workspace_id = NEW.workspace_id AND prior.event_id = NEW.event_id
    AND prior.sequence_number < NEW.sequence_number
    AND ((prior.source_pool_id = NEW.destination_pool_id AND prior.source_pool_version_id IS NOT NEW.destination_pool_version_id)
      OR (prior.destination_pool_id = NEW.destination_pool_id AND prior.destination_pool_version_id IS NOT NEW.destination_pool_version_id))
)
OR sympose_pd01_fingerprint(json_object(
  'schema', 'pd01-capacity-transfer-decision/v1', 'workspaceId', NEW.workspace_id,
  'eventId', NEW.event_id, 'sequenceNumber', NEW.sequence_number,
  'sourcePoolId', NEW.source_pool_id, 'sourcePoolVersionId', NEW.source_pool_version_id,
  'destinationPoolId', NEW.destination_pool_id, 'destinationPoolVersionId', NEW.destination_pool_version_id,
  'unitKind', NEW.unit_kind, 'quantity', NEW.quantity, 'sourceBefore', NEW.source_before,
  'sourceAfter', NEW.source_after, 'destinationBefore', NEW.destination_before,
  'destinationAfter', NEW.destination_after, 'actorAccountId', NEW.actor_account_id,
  'reason', NEW.reason, 'approvalReference', NEW.approval_reference, 'decidedAt', NEW.decided_at,
  'idempotencyKey', NEW.idempotency_key)) IS NOT NEW.fingerprint
OR NEW.source_before IS NOT (
  (SELECT capacity FROM program_capacity_pool_versions WHERE id = NEW.source_pool_version_id)
  + COALESCE((SELECT SUM(quantity) FROM capacity_transfer_decisions prior WHERE prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id AND prior.destination_pool_id = NEW.source_pool_id
      AND prior.sequence_number < NEW.sequence_number), 0)
  - COALESCE((SELECT SUM(quantity) FROM capacity_transfer_decisions prior WHERE prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id AND prior.source_pool_id = NEW.source_pool_id
      AND prior.sequence_number < NEW.sequence_number), 0))
OR NEW.destination_before IS NOT (
  (SELECT capacity FROM program_capacity_pool_versions WHERE id = NEW.destination_pool_version_id)
  + COALESCE((SELECT SUM(quantity) FROM capacity_transfer_decisions prior WHERE prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id AND prior.destination_pool_id = NEW.destination_pool_id
      AND prior.sequence_number < NEW.sequence_number), 0)
  - COALESCE((SELECT SUM(quantity) FROM capacity_transfer_decisions prior WHERE prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id AND prior.source_pool_id = NEW.destination_pool_id
      AND prior.sequence_number < NEW.sequence_number), 0))
OR NEW.source_after < 0
BEGIN SELECT RAISE(ABORT, 'capacity transfer conservation or ordering mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_capacity_transfer_receipts_immutable BEFORE UPDATE ON capacity_transfer_receipts
BEGIN SELECT RAISE(ABORT, 'capacity_transfer_receipts is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_capacity_transfer_receipts_no_delete BEFORE DELETE ON capacity_transfer_receipts
BEGIN SELECT RAISE(ABORT, 'capacity_transfer_receipts is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_capacity_transfer_receipts_insert_guard BEFORE INSERT ON capacity_transfer_receipts
WHEN NOT EXISTS (SELECT 1 FROM capacity_transfer_decisions d WHERE d.workspace_id = NEW.workspace_id
  AND NEW.id = 'receipt:' || d.id
  AND d.event_id = NEW.event_id AND d.id = NEW.decision_id AND d.sequence_number = NEW.sequence_number
  AND d.fingerprint = NEW.fingerprint AND d.quantity = NEW.quantity
  AND d.unit_kind = NEW.unit_kind
  AND d.source_pool_id = NEW.source_pool_id AND d.source_pool_version_id = NEW.source_pool_version_id
  AND d.destination_pool_id = NEW.destination_pool_id AND d.destination_pool_version_id = NEW.destination_pool_version_id
  AND d.source_before = NEW.source_before AND d.source_after = NEW.source_after
  AND d.destination_before = NEW.destination_before AND d.destination_after = NEW.destination_after
  AND d.decided_at = NEW.recorded_at)
BEGIN SELECT RAISE(ABORT, 'capacity transfer receipt binding mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_capacity_transfer_decisions_receipt AFTER INSERT ON capacity_transfer_decisions
BEGIN
  INSERT INTO capacity_transfer_receipts
    (id, workspace_id, event_id, decision_id, sequence_number, source_pool_id, source_pool_version_id,
     destination_pool_id, destination_pool_version_id, unit_kind, quantity, source_before, source_after,
     destination_before, destination_after, recorded_at, fingerprint)
  VALUES ('receipt:' || NEW.id, NEW.workspace_id, NEW.event_id, NEW.id, NEW.sequence_number, NEW.source_pool_id,
    NEW.source_pool_version_id, NEW.destination_pool_id, NEW.destination_pool_version_id, NEW.unit_kind,
    NEW.quantity, NEW.source_before, NEW.source_after, NEW.destination_before, NEW.destination_after,
    NEW.decided_at, NEW.fingerprint);
END;
CREATE TRIGGER IF NOT EXISTS trg_capacity_transfer_decisions_immutable BEFORE UPDATE ON capacity_transfer_decisions
BEGIN SELECT RAISE(ABORT, 'capacity_transfer_decisions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_capacity_transfer_decisions_no_delete BEFORE DELETE ON capacity_transfer_decisions
BEGIN SELECT RAISE(ABORT, 'capacity_transfer_decisions is immutable'); END;
`;

// V9 is deliberately additive.  V8 recommendation rows cannot be made authoritative by
// guessing their reviewer or context, so db.ts refuses that migration before this packet runs.
const v9CanonicalInstantCheck = (column: string): string => `(length(CAST(${column} AS BLOB)) = 24 AND substr(${column},5,1)='-' AND substr(${column},8,1)='-' AND substr(${column},11,1)='T' AND substr(${column},14,1)=':' AND substr(${column},17,1)=':' AND substr(${column},20,1)='.' AND substr(${column},24,1)='Z' AND substr(${column},1,4) NOT GLOB '*[^0-9]*' AND substr(${column},6,2) NOT GLOB '*[^0-9]*' AND substr(${column},9,2) NOT GLOB '*[^0-9]*' AND substr(${column},12,2) NOT GLOB '*[^0-9]*' AND substr(${column},15,2) NOT GLOB '*[^0-9]*' AND substr(${column},18,2) NOT GLOB '*[^0-9]*' AND substr(${column},21,3) NOT GLOB '*[^0-9]*' AND CAST(substr(${column},6,2) AS INTEGER) BETWEEN 1 AND 12 AND CAST(substr(${column},9,2) AS INTEGER) BETWEEN 1 AND 31 AND CAST(substr(${column},12,2) AS INTEGER) BETWEEN 0 AND 23 AND CAST(substr(${column},15,2) AS INTEGER) BETWEEN 0 AND 59 AND CAST(substr(${column},18,2) AS INTEGER) BETWEEN 0 AND 59 AND CAST(substr(${column},21,3) AS INTEGER) BETWEEN 0 AND 999 AND strftime('%Y-%m-%d',${column}) = substr(${column},1,10))`;
export const V9_DDL = `
CREATE TABLE IF NOT EXISTS account_person_bindings (
  id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) BETWEEN 1 AND 128 AND instr(id, char(0)) = 0),
  workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 128 AND instr(workspace_id, char(0)) = 0) REFERENCES workspaces(id),
  account_id TEXT NOT NULL CHECK (length(CAST(account_id AS BLOB)) BETWEEN 1 AND 128 AND instr(account_id, char(0)) = 0) REFERENCES accounts(id),
  person_id TEXT NOT NULL CHECK (length(CAST(person_id AS BLOB)) BETWEEN 1 AND 128 AND instr(person_id, char(0)) = 0) REFERENCES people(id),
  bound_by_account_id TEXT NOT NULL CHECK (length(CAST(bound_by_account_id AS BLOB)) BETWEEN 1 AND 128 AND instr(bound_by_account_id, char(0)) = 0) REFERENCES accounts(id),
  binding_basis TEXT NOT NULL CHECK (length(CAST(binding_basis AS BLOB)) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")},
  fingerprint_algorithm TEXT NOT NULL CHECK (fingerprint_algorithm = 'sha256-canonical-json-v1'),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (workspace_id, account_id), UNIQUE (workspace_id, person_id),
  UNIQUE (workspace_id, fingerprint), UNIQUE (workspace_id, account_id, person_id)
) STRICT;

CREATE TABLE IF NOT EXISTS event_reviewer_assignments (
  id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) BETWEEN 1 AND 128 AND instr(id, char(0)) = 0),
  workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 128 AND instr(workspace_id, char(0)) = 0) REFERENCES workspaces(id),
  event_id TEXT NOT NULL CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 128 AND instr(event_id, char(0)) = 0) REFERENCES events(id),
  reviewer_account_id TEXT NOT NULL CHECK (length(CAST(reviewer_account_id AS BLOB)) BETWEEN 1 AND 128 AND instr(reviewer_account_id, char(0)) = 0) REFERENCES accounts(id),
  reviewer_person_id TEXT NOT NULL CHECK (length(CAST(reviewer_person_id AS BLOB)) BETWEEN 1 AND 128 AND instr(reviewer_person_id, char(0)) = 0) REFERENCES people(id),
  account_person_binding_id TEXT NOT NULL CHECK (length(CAST(account_person_binding_id AS BLOB)) BETWEEN 1 AND 128 AND instr(account_person_binding_id, char(0)) = 0) REFERENCES account_person_bindings(id),
  assigned_by_account_id TEXT NOT NULL CHECK (length(CAST(assigned_by_account_id AS BLOB)) BETWEEN 1 AND 128 AND instr(assigned_by_account_id, char(0)) = 0) REFERENCES accounts(id),
  created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")},
  fingerprint_algorithm TEXT NOT NULL CHECK (fingerprint_algorithm = 'sha256-canonical-json-v1'),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (workspace_id, event_id, reviewer_account_id),
  UNIQUE (workspace_id, event_id, reviewer_person_id), UNIQUE (workspace_id, fingerprint),
  UNIQUE (workspace_id, event_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS event_reviewer_assignment_states (
  id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) BETWEEN 1 AND 128 AND instr(id, char(0)) = 0),
  workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 128 AND instr(workspace_id, char(0)) = 0) REFERENCES workspaces(id), event_id TEXT NOT NULL CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 128 AND instr(event_id, char(0)) = 0) REFERENCES events(id),
  event_reviewer_assignment_id TEXT NOT NULL CHECK (length(CAST(event_reviewer_assignment_id AS BLOB)) BETWEEN 1 AND 128 AND instr(event_reviewer_assignment_id, char(0)) = 0) REFERENCES event_reviewer_assignments(id),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'REVOKED')),
  sequence_number INTEGER NOT NULL CHECK (typeof(sequence_number)='integer' AND sequence_number >= 1),
  actor_account_id TEXT NOT NULL CHECK (length(CAST(actor_account_id AS BLOB)) BETWEEN 1 AND 128 AND instr(actor_account_id, char(0)) = 0) REFERENCES accounts(id), reason TEXT CHECK (reason IS NULL OR length(CAST(reason AS BLOB)) BETWEEN 1 AND 1024), created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")},
  UNIQUE (event_reviewer_assignment_id, sequence_number)
) STRICT;

CREATE TABLE IF NOT EXISTS review_context_versions (
  id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) BETWEEN 1 AND 128 AND instr(id, char(0)) = 0),
  workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 128 AND instr(workspace_id, char(0)) = 0) REFERENCES workspaces(id), event_id TEXT NOT NULL CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 128 AND instr(event_id, char(0)) = 0) REFERENCES events(id),
  context_kind TEXT NOT NULL CHECK (context_kind IN ('ADVOCACY_POLICY','VISIBILITY','BLINDNESS','SELECTION_CONTEXT')),
  version_number INTEGER NOT NULL CHECK (typeof(version_number)='integer' AND version_number >= 1),
  context_schema TEXT NOT NULL, context_json TEXT NOT NULL CHECK (typeof(context_json)='text' AND json_valid(context_json)=1 AND length(CAST(context_json AS BLOB)) <= 524288),
  fingerprint_algorithm TEXT NOT NULL CHECK (fingerprint_algorithm='sha256-canonical-json-v1'),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  issued_by_account_id TEXT NOT NULL CHECK (length(CAST(issued_by_account_id AS BLOB)) BETWEEN 1 AND 128 AND instr(issued_by_account_id, char(0)) = 0) REFERENCES accounts(id), issued_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("issued_at")},
  UNIQUE (workspace_id, event_id, context_kind, version_number), UNIQUE (workspace_id, event_id, context_kind, id),
  UNIQUE (workspace_id, fingerprint)
) STRICT;

-- These are V9 physical definitions. V8 remains literal history; V8->V9 rebuilds these empty
-- tables before applying the guards below. Fresh DDL creates these definitions directly.
CREATE TABLE IF NOT EXISTS recommendation_sets (
  id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) BETWEEN 1 AND 128 AND instr(id, char(0)) = 0), workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 128 AND instr(workspace_id, char(0)) = 0) REFERENCES workspaces(id), event_id TEXT NOT NULL CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 128 AND instr(event_id, char(0)) = 0) REFERENCES events(id),
  reviewer_account_id TEXT NOT NULL CHECK (length(CAST(reviewer_account_id AS BLOB)) BETWEEN 1 AND 128 AND instr(reviewer_account_id, char(0)) = 0) REFERENCES accounts(id), reviewer_person_id TEXT NOT NULL CHECK (length(CAST(reviewer_person_id AS BLOB)) BETWEEN 1 AND 128 AND instr(reviewer_person_id, char(0)) = 0) REFERENCES people(id),
  event_reviewer_assignment_id TEXT NOT NULL CHECK (length(CAST(event_reviewer_assignment_id AS BLOB)) BETWEEN 1 AND 128 AND instr(event_reviewer_assignment_id, char(0)) = 0) REFERENCES event_reviewer_assignments(id),
  account_person_binding_id TEXT NOT NULL CHECK (length(CAST(account_person_binding_id AS BLOB)) BETWEEN 1 AND 128 AND instr(account_person_binding_id, char(0)) = 0) REFERENCES account_person_bindings(id), created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")}, archived_at TEXT CHECK (archived_at IS NULL OR ${v9CanonicalInstantCheck("archived_at")}),
  UNIQUE (workspace_id,id), UNIQUE (workspace_id,event_id,id), UNIQUE (workspace_id,event_id,reviewer_account_id),
  UNIQUE (workspace_id,event_id,reviewer_person_id)
) STRICT;
CREATE TABLE IF NOT EXISTS recommendation_set_versions (
  id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) BETWEEN 1 AND 128 AND instr(id, char(0)) = 0), workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 128 AND instr(workspace_id, char(0)) = 0) REFERENCES workspaces(id), event_id TEXT NOT NULL CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 128 AND instr(event_id, char(0)) = 0) REFERENCES events(id),
  recommendation_set_id TEXT NOT NULL CHECK (length(CAST(recommendation_set_id AS BLOB)) BETWEEN 1 AND 128 AND instr(recommendation_set_id, char(0)) = 0), reviewer_account_id TEXT NOT NULL CHECK (length(CAST(reviewer_account_id AS BLOB)) BETWEEN 1 AND 128 AND instr(reviewer_account_id, char(0)) = 0) REFERENCES accounts(id), reviewer_person_id TEXT NOT NULL CHECK (length(CAST(reviewer_person_id AS BLOB)) BETWEEN 1 AND 128 AND instr(reviewer_person_id, char(0)) = 0) REFERENCES people(id),
  event_reviewer_assignment_id TEXT NOT NULL CHECK (length(CAST(event_reviewer_assignment_id AS BLOB)) BETWEEN 1 AND 128 AND instr(event_reviewer_assignment_id, char(0)) = 0) REFERENCES event_reviewer_assignments(id), account_person_binding_id TEXT NOT NULL CHECK (length(CAST(account_person_binding_id AS BLOB)) BETWEEN 1 AND 128 AND instr(account_person_binding_id, char(0)) = 0) REFERENCES account_person_bindings(id),
  version_number INTEGER NOT NULL CHECK(typeof(version_number)='integer' AND version_number>=1),
  eligibility_snapshot_json TEXT NOT NULL CHECK(typeof(eligibility_snapshot_json)='text' AND json_valid(eligibility_snapshot_json)=1 AND length(CAST(eligibility_snapshot_json AS BLOB))<=524288),
  eligibility_fingerprint TEXT NOT NULL CHECK(length(eligibility_fingerprint)=64 AND eligibility_fingerprint NOT GLOB '*[^0-9a-f]*'), maximum_entries INTEGER NOT NULL CHECK(typeof(maximum_entries)='integer' AND maximum_entries>=1),
  policy_version_id TEXT NOT NULL CHECK (length(CAST(policy_version_id AS BLOB)) BETWEEN 1 AND 128 AND instr(policy_version_id, char(0)) = 0) REFERENCES review_context_versions(id), policy_version_fingerprint TEXT NOT NULL CHECK(length(policy_version_fingerprint)=64 AND policy_version_fingerprint NOT GLOB '*[^0-9a-f]*'),
  visibility_version_id TEXT NOT NULL CHECK (length(CAST(visibility_version_id AS BLOB)) BETWEEN 1 AND 128 AND instr(visibility_version_id, char(0)) = 0) REFERENCES review_context_versions(id), visibility_version_fingerprint TEXT NOT NULL CHECK(length(visibility_version_fingerprint)=64 AND visibility_version_fingerprint NOT GLOB '*[^0-9a-f]*'),
  blindness_version_id TEXT NOT NULL CHECK (length(CAST(blindness_version_id AS BLOB)) BETWEEN 1 AND 128 AND instr(blindness_version_id, char(0)) = 0) REFERENCES review_context_versions(id), blindness_version_fingerprint TEXT NOT NULL CHECK(length(blindness_version_fingerprint)=64 AND blindness_version_fingerprint NOT GLOB '*[^0-9a-f]*'),
  selection_context_version_id TEXT NOT NULL CHECK (length(CAST(selection_context_version_id AS BLOB)) BETWEEN 1 AND 128 AND instr(selection_context_version_id, char(0)) = 0) REFERENCES review_context_versions(id), selection_context_reference TEXT NOT NULL CHECK(length(CAST(selection_context_reference AS BLOB)) BETWEEN 1 AND 256),
  selection_context_fingerprint TEXT NOT NULL CHECK(length(selection_context_fingerprint)=64 AND selection_context_fingerprint NOT GLOB '*[^0-9a-f]*'),
  content_fingerprint TEXT CHECK(content_fingerprint IS NULL OR(length(content_fingerprint)=64 AND content_fingerprint NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")}, submitted_at TEXT CHECK (submitted_at IS NULL OR ${v9CanonicalInstantCheck("submitted_at")}), sealed_at TEXT CHECK (sealed_at IS NULL OR ${v9CanonicalInstantCheck("sealed_at")}),
  UNIQUE(workspace_id,id), UNIQUE(workspace_id,event_id,id), UNIQUE(workspace_id,event_id,id,content_fingerprint), UNIQUE(workspace_id,event_id,recommendation_set_id,version_number),
  FOREIGN KEY(workspace_id,event_id,recommendation_set_id) REFERENCES recommendation_sets(workspace_id,event_id,id)
) STRICT;
CREATE TABLE IF NOT EXISTS recommendation_entries (
  id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) BETWEEN 1 AND 128 AND instr(id, char(0)) = 0), workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 128 AND instr(workspace_id, char(0)) = 0) REFERENCES workspaces(id), event_id TEXT NOT NULL CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 128 AND instr(event_id, char(0)) = 0) REFERENCES events(id), recommendation_set_version_id TEXT NOT NULL CHECK (length(CAST(recommendation_set_version_id AS BLOB)) BETWEEN 1 AND 128 AND instr(recommendation_set_version_id, char(0)) = 0),
  submission_id TEXT NOT NULL CHECK (length(CAST(submission_id AS BLOB)) BETWEEN 1 AND 128 AND instr(submission_id, char(0)) = 0) REFERENCES submissions(id), submission_revision_id TEXT NOT NULL CHECK (length(CAST(submission_revision_id AS BLOB)) BETWEEN 1 AND 128 AND instr(submission_revision_id, char(0)) = 0) REFERENCES submission_revisions(id),
  stance TEXT NOT NULL CHECK(stance IN('PROMOTE','STRONGLY_PROMOTE','OPPOSE','NO_POSITION')), rank INTEGER CHECK(rank IS NULL OR(typeof(rank)='integer' AND rank>=1)),
  strength INTEGER CHECK(strength IS NULL OR(typeof(strength)='integer' AND strength BETWEEN 0 AND 100)), rationale TEXT CHECK(rationale IS NULL OR length(CAST(rationale AS BLOB))<=4096),
  follow_up_willingness INTEGER CHECK(follow_up_willingness IS NULL OR follow_up_willingness IN(0,1)), evidence_json TEXT CHECK(evidence_json IS NULL OR(typeof(evidence_json)='text' AND json_valid(evidence_json)=1 AND length(CAST(evidence_json AS BLOB))<=524288)), created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")},
  UNIQUE(workspace_id,id), UNIQUE(recommendation_set_version_id,submission_revision_id), UNIQUE(recommendation_set_version_id,rank),
  FOREIGN KEY(workspace_id,event_id,recommendation_set_version_id) REFERENCES recommendation_set_versions(workspace_id,event_id,id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_recommendation_versions_set ON recommendation_set_versions(workspace_id,event_id,recommendation_set_id,version_number);
CREATE INDEX IF NOT EXISTS idx_recommendation_entries_revision ON recommendation_entries(workspace_id,event_id,submission_revision_id);


CREATE TRIGGER IF NOT EXISTS trg_account_person_bindings_guard BEFORE INSERT ON account_person_bindings
WHEN NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM people p WHERE p.id=NEW.person_id AND p.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM accounts b WHERE b.id=NEW.bound_by_account_id AND b.workspace_id=NEW.workspace_id)
 OR sympose_pd01_fingerprint(json_object('schema','pd01-account-person-binding/v1','workspaceId',NEW.workspace_id,'accountId',NEW.account_id,'personId',NEW.person_id,'boundByAccountId',NEW.bound_by_account_id,'bindingBasis',NEW.binding_basis,'createdAt',NEW.created_at)) IS NOT NEW.fingerprint
BEGIN SELECT RAISE(ABORT, 'account_person_bindings binding or fingerprint mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_account_person_bindings_immutable BEFORE UPDATE ON account_person_bindings BEGIN SELECT RAISE(ABORT, 'account_person_bindings is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_account_person_bindings_no_delete BEFORE DELETE ON account_person_bindings BEGIN SELECT RAISE(ABORT, 'account_person_bindings is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_event_reviewer_assignments_guard BEFORE INSERT ON event_reviewer_assignments
WHEN NOT EXISTS (SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=NEW.reviewer_account_id AND a.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM people p WHERE p.id=NEW.reviewer_person_id AND p.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=NEW.assigned_by_account_id AND a.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM account_person_bindings b WHERE b.id=NEW.account_person_binding_id AND b.workspace_id=NEW.workspace_id AND b.account_id=NEW.reviewer_account_id AND b.person_id=NEW.reviewer_person_id)
 OR sympose_pd01_fingerprint(json_object('schema','pd01-event-reviewer-assignment/v1','workspaceId',NEW.workspace_id,'eventId',NEW.event_id,'reviewerAccountId',NEW.reviewer_account_id,'reviewerPersonId',NEW.reviewer_person_id,'accountPersonBindingId',NEW.account_person_binding_id,'assignedByAccountId',NEW.assigned_by_account_id,'createdAt',NEW.created_at)) IS NOT NEW.fingerprint
BEGIN SELECT RAISE(ABORT, 'event_reviewer_assignments binding or fingerprint mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_event_reviewer_assignments_immutable BEFORE UPDATE ON event_reviewer_assignments BEGIN SELECT RAISE(ABORT, 'event_reviewer_assignments is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_event_reviewer_assignments_no_delete BEFORE DELETE ON event_reviewer_assignments BEGIN SELECT RAISE(ABORT, 'event_reviewer_assignments is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_event_reviewer_assignment_states_guard BEFORE INSERT ON event_reviewer_assignment_states
WHEN NOT EXISTS (SELECT 1 FROM event_reviewer_assignments a WHERE a.id=NEW.event_reviewer_assignment_id AND a.workspace_id=NEW.workspace_id AND a.event_id=NEW.event_id)
 OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=NEW.actor_account_id AND a.workspace_id=NEW.workspace_id)
 OR NEW.sequence_number IS NOT COALESCE((SELECT MAX(sequence_number)+1 FROM event_reviewer_assignment_states WHERE event_reviewer_assignment_id=NEW.event_reviewer_assignment_id),1)
BEGIN SELECT RAISE(ABORT, 'event_reviewer_assignment_states binding or sequence mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_event_reviewer_assignment_states_immutable BEFORE UPDATE ON event_reviewer_assignment_states BEGIN SELECT RAISE(ABORT, 'event_reviewer_assignment_states is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_event_reviewer_assignment_states_no_delete BEFORE DELETE ON event_reviewer_assignment_states BEGIN SELECT RAISE(ABORT, 'event_reviewer_assignment_states is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_context_versions_guard BEFORE INSERT ON review_context_versions
WHEN NOT EXISTS (SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=NEW.issued_by_account_id AND a.workspace_id=NEW.workspace_id)
 OR NEW.context_schema IS NOT CASE NEW.context_kind WHEN 'ADVOCACY_POLICY' THEN 'pd01-advocacy-policy/v1' WHEN 'VISIBILITY' THEN 'pd01-visibility-snapshot/v1' WHEN 'BLINDNESS' THEN 'pd01-blindness-policy/v1' ELSE 'pd01-selection-context/v1' END
 OR json_extract(NEW.context_json, '$.schema') IS NOT NEW.context_schema
 OR (NEW.context_kind='ADVOCACY_POLICY' AND ((SELECT COUNT(*) FROM json_each(NEW.context_json))<>3 OR EXISTS (SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN ('schema','maximumEntries','eligibleRevisions')) OR json_type(NEW.context_json,'$.maximumEntries') IS NOT 'integer' OR json_extract(NEW.context_json,'$.maximumEntries') < 1 OR json_extract(NEW.context_json,'$.maximumEntries') > 10000))
 OR (NEW.context_kind='ADVOCACY_POLICY' AND (json_type(NEW.context_json,'$.eligibleRevisions') <> 'array' OR EXISTS (SELECT 1 FROM json_each(NEW.context_json,'$.eligibleRevisions') x WHERE json_type(x.value)<>'object' OR (SELECT COUNT(*) FROM json_each(x.value))<>3 OR EXISTS (SELECT 1 FROM json_each(x.value) k WHERE k.key NOT IN ('submissionId','submissionRevisionId','submissionRevisionFingerprint')) OR json_type(x.value,'$.submissionId')<>'text' OR json_type(x.value,'$.submissionRevisionId')<>'text' OR json_type(x.value,'$.submissionRevisionFingerprint')<>'text' OR length(json_extract(x.value,'$.submissionRevisionFingerprint'))<>64 OR NOT EXISTS (SELECT 1 FROM submissions s JOIN submission_revisions r ON r.id=json_extract(x.value,'$.submissionRevisionId') AND r.submission_id=s.id WHERE s.id=json_extract(x.value,'$.submissionId') AND s.workspace_id=NEW.workspace_id AND s.event_id=NEW.event_id AND r.fingerprint=json_extract(x.value,'$.submissionRevisionFingerprint'))) OR EXISTS (SELECT json_extract(x.value,'$.submissionId'),json_extract(x.value,'$.submissionRevisionId'),json_extract(x.value,'$.submissionRevisionFingerprint') FROM json_each(NEW.context_json,'$.eligibleRevisions') x GROUP BY 1,2,3 HAVING COUNT(*)>1)))
 OR (NEW.context_kind='VISIBILITY' AND ((SELECT COUNT(*) FROM json_each(NEW.context_json))<>2 OR EXISTS (SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN ('schema','visibleRevisions')) OR json_type(NEW.context_json,'$.visibleRevisions') <> 'array' OR EXISTS (SELECT 1 FROM json_each(NEW.context_json,'$.visibleRevisions') x WHERE json_type(x.value)<>'object' OR (SELECT COUNT(*) FROM json_each(x.value))<>3 OR EXISTS (SELECT 1 FROM json_each(x.value) k WHERE k.key NOT IN ('submissionId','submissionRevisionId','submissionRevisionFingerprint')) OR json_type(x.value,'$.submissionId')<>'text' OR json_type(x.value,'$.submissionRevisionId')<>'text' OR json_type(x.value,'$.submissionRevisionFingerprint')<>'text' OR length(json_extract(x.value,'$.submissionRevisionFingerprint'))<>64 OR NOT EXISTS (SELECT 1 FROM submissions s JOIN submission_revisions r ON r.id=json_extract(x.value,'$.submissionRevisionId') AND r.submission_id=s.id WHERE s.id=json_extract(x.value,'$.submissionId') AND s.workspace_id=NEW.workspace_id AND s.event_id=NEW.event_id AND r.fingerprint=json_extract(x.value,'$.submissionRevisionFingerprint'))) OR EXISTS (SELECT json_extract(x.value,'$.submissionId'),json_extract(x.value,'$.submissionRevisionId'),json_extract(x.value,'$.submissionRevisionFingerprint') FROM json_each(NEW.context_json,'$.visibleRevisions') x GROUP BY 1,2,3 HAVING COUNT(*)>1)))
 OR (NEW.context_kind='BLINDNESS' AND ((SELECT COUNT(*) FROM json_each(NEW.context_json))<>3 OR EXISTS (SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN ('schema','disclosureStage','organizerAdvocacyAggregationPermitted')) OR json_type(NEW.context_json,'$.organizerAdvocacyAggregationPermitted') IS NULL OR json_type(NEW.context_json,'$.organizerAdvocacyAggregationPermitted') NOT IN ('true','false') OR json_extract(NEW.context_json,'$.disclosureStage') IS NULL OR json_extract(NEW.context_json,'$.disclosureStage') NOT IN ('BLIND_REVIEW')))
 OR (NEW.context_kind='SELECTION_CONTEXT' AND ((SELECT COUNT(*) FROM json_each(NEW.context_json))<>3 OR EXISTS (SELECT 1 FROM json_each(NEW.context_json) WHERE key NOT IN ('schema','decisionBoundary','resolvedRevisions')) OR json_type(NEW.context_json,'$.decisionBoundary')<>'text' OR length(CAST(json_extract(NEW.context_json,'$.decisionBoundary') AS BLOB)) NOT BETWEEN 1 AND 256 OR json_type(NEW.context_json,'$.resolvedRevisions') <> 'array' OR EXISTS (SELECT 1 FROM json_each(NEW.context_json,'$.resolvedRevisions') x WHERE json_type(x.value)<>'object' OR (SELECT COUNT(*) FROM json_each(x.value))<>3 OR EXISTS (SELECT 1 FROM json_each(x.value) k WHERE k.key NOT IN ('submissionId','submissionRevisionId','submissionRevisionFingerprint')) OR json_type(x.value,'$.submissionId')<>'text' OR json_type(x.value,'$.submissionRevisionId')<>'text' OR json_type(x.value,'$.submissionRevisionFingerprint')<>'text' OR length(json_extract(x.value,'$.submissionRevisionFingerprint'))<>64 OR NOT EXISTS (SELECT 1 FROM submissions s JOIN submission_revisions r ON r.id=json_extract(x.value,'$.submissionRevisionId') AND r.submission_id=s.id WHERE s.id=json_extract(x.value,'$.submissionId') AND s.workspace_id=NEW.workspace_id AND s.event_id=NEW.event_id AND r.fingerprint=json_extract(x.value,'$.submissionRevisionFingerprint'))) OR EXISTS (SELECT json_extract(x.value,'$.submissionId'),json_extract(x.value,'$.submissionRevisionId'),json_extract(x.value,'$.submissionRevisionFingerprint') FROM json_each(NEW.context_json,'$.resolvedRevisions') x GROUP BY 1,2,3 HAVING COUNT(*)>1)))
 OR sympose_pd01_canonical_json(NEW.context_json) IS NOT NEW.context_json
 OR sympose_pd01_fingerprint(NEW.context_json) IS NOT NEW.fingerprint
 OR NEW.version_number IS NOT COALESCE((SELECT MAX(version_number)+1 FROM review_context_versions WHERE workspace_id=NEW.workspace_id AND event_id=NEW.event_id AND context_kind=NEW.context_kind),1)
BEGIN SELECT RAISE(ABORT, 'review_context_versions binding, canonical, or sequence mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_context_versions_immutable BEFORE UPDATE ON review_context_versions BEGIN SELECT RAISE(ABORT, 'review_context_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_context_versions_no_delete BEFORE DELETE ON review_context_versions BEGIN SELECT RAISE(ABORT, 'review_context_versions is immutable'); END;

DROP TRIGGER IF EXISTS trg_recommendation_sets_guard;
DROP TRIGGER IF EXISTS trg_recommendation_sets_identity_immutable;
DROP TRIGGER IF EXISTS trg_recommendation_set_versions_guard;
DROP TRIGGER IF EXISTS trg_recommendation_set_versions_finalize_or_immutable;
DROP TRIGGER IF EXISTS trg_recommendation_set_versions_no_delete;
DROP TRIGGER IF EXISTS trg_recommendation_entries_guard;
DROP TRIGGER IF EXISTS trg_recommendation_entries_immutable;
DROP TRIGGER IF EXISTS trg_recommendation_entries_no_delete;

CREATE TRIGGER IF NOT EXISTS trg_recommendation_sets_guard BEFORE INSERT ON recommendation_sets
WHEN NOT EXISTS (SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM event_reviewer_assignments a WHERE a.id=NEW.event_reviewer_assignment_id AND a.workspace_id=NEW.workspace_id AND a.event_id=NEW.event_id AND a.reviewer_account_id=NEW.reviewer_account_id AND a.reviewer_person_id=NEW.reviewer_person_id AND a.account_person_binding_id=NEW.account_person_binding_id)
BEGIN SELECT RAISE(ABORT, 'recommendation_sets identity binding mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_sets_immutable BEFORE UPDATE ON recommendation_sets BEGIN SELECT RAISE(ABORT, 'recommendation_sets is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_sets_no_delete BEFORE DELETE ON recommendation_sets BEGIN SELECT RAISE(ABORT, 'recommendation_sets is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_recommendation_set_versions_guard BEFORE INSERT ON recommendation_set_versions
WHEN NOT EXISTS (SELECT 1 FROM recommendation_sets s WHERE s.id=NEW.recommendation_set_id AND s.workspace_id=NEW.workspace_id AND s.event_id=NEW.event_id AND s.reviewer_account_id=NEW.reviewer_account_id AND s.reviewer_person_id=NEW.reviewer_person_id AND s.event_reviewer_assignment_id=NEW.event_reviewer_assignment_id AND s.account_person_binding_id=NEW.account_person_binding_id)
 OR NEW.version_number IS NOT COALESCE((SELECT MAX(version_number)+1 FROM recommendation_set_versions WHERE workspace_id=NEW.workspace_id AND recommendation_set_id=NEW.recommendation_set_id),1)
 OR sympose_pd01_canonical_json(NEW.eligibility_snapshot_json) IS NOT NEW.eligibility_snapshot_json
 OR NEW.eligibility_fingerprint IS NOT sympose_pd01_fingerprint(NEW.eligibility_snapshot_json)
 OR NEW.maximum_entries IS NOT (SELECT json_extract(context_json, '$.maximumEntries') FROM review_context_versions WHERE id=NEW.policy_version_id)
 OR NEW.eligibility_snapshot_json IS NOT (SELECT sympose_pd01_canonical_json(json_extract(context_json, '$.eligibleRevisions')) FROM review_context_versions WHERE id=NEW.policy_version_id)
 OR NOT EXISTS (SELECT 1 FROM review_context_versions c WHERE c.id=NEW.policy_version_id AND c.workspace_id=NEW.workspace_id AND c.event_id=NEW.event_id AND c.context_kind='ADVOCACY_POLICY' AND c.fingerprint=NEW.policy_version_fingerprint)
 OR NOT EXISTS (SELECT 1 FROM review_context_versions c WHERE c.id=NEW.visibility_version_id AND c.workspace_id=NEW.workspace_id AND c.event_id=NEW.event_id AND c.context_kind='VISIBILITY' AND c.fingerprint=NEW.visibility_version_fingerprint)
 OR NOT EXISTS (SELECT 1 FROM review_context_versions c WHERE c.id=NEW.blindness_version_id AND c.workspace_id=NEW.workspace_id AND c.event_id=NEW.event_id AND c.context_kind='BLINDNESS' AND c.fingerprint=NEW.blindness_version_fingerprint)
 OR NOT EXISTS (SELECT 1 FROM review_context_versions c WHERE c.id=NEW.selection_context_version_id AND c.workspace_id=NEW.workspace_id AND c.event_id=NEW.event_id AND c.context_kind='SELECTION_CONTEXT' AND c.fingerprint=NEW.selection_context_fingerprint)
 OR NEW.selection_context_reference IS NOT (SELECT json_extract(context_json,'$.decisionBoundary') FROM review_context_versions WHERE id=NEW.selection_context_version_id)
 OR NEW.submitted_at IS NOT NULL OR NEW.sealed_at IS NOT NULL OR NEW.content_fingerprint IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'recommendation_set_versions V9 binding mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_set_versions_finalize_or_immutable BEFORE UPDATE ON recommendation_set_versions
WHEN NOT (NEW.id IS OLD.id AND NEW.workspace_id IS OLD.workspace_id AND NEW.event_id IS OLD.event_id AND NEW.recommendation_set_id IS OLD.recommendation_set_id AND NEW.reviewer_account_id IS OLD.reviewer_account_id AND NEW.reviewer_person_id IS OLD.reviewer_person_id AND NEW.event_reviewer_assignment_id IS OLD.event_reviewer_assignment_id AND NEW.account_person_binding_id IS OLD.account_person_binding_id AND NEW.version_number IS OLD.version_number AND NEW.eligibility_snapshot_json IS OLD.eligibility_snapshot_json AND NEW.eligibility_fingerprint IS OLD.eligibility_fingerprint AND NEW.maximum_entries IS OLD.maximum_entries AND NEW.policy_version_id IS OLD.policy_version_id AND NEW.policy_version_fingerprint IS OLD.policy_version_fingerprint AND NEW.visibility_version_id IS OLD.visibility_version_id AND NEW.visibility_version_fingerprint IS OLD.visibility_version_fingerprint AND NEW.blindness_version_id IS OLD.blindness_version_id AND NEW.blindness_version_fingerprint IS OLD.blindness_version_fingerprint AND NEW.selection_context_reference IS OLD.selection_context_reference AND NEW.selection_context_fingerprint IS OLD.selection_context_fingerprint AND NEW.selection_context_version_id IS OLD.selection_context_version_id AND NEW.created_at IS OLD.created_at AND OLD.submitted_at IS NULL AND OLD.sealed_at IS NULL AND NEW.submitted_at IS NOT NULL AND NEW.sealed_at IS NOT NULL AND NEW.submitted_at >= NEW.created_at AND NEW.sealed_at >= NEW.submitted_at AND EXISTS (SELECT 1 FROM event_reviewer_assignment_states st WHERE st.event_reviewer_assignment_id=NEW.event_reviewer_assignment_id AND st.sequence_number=(SELECT MAX(sequence_number) FROM event_reviewer_assignment_states WHERE event_reviewer_assignment_id=NEW.event_reviewer_assignment_id) AND st.state='ACTIVE') AND NEW.content_fingerprint IS sympose_pd01_fingerprint(json_object('schema','pd01-recommendation-ballot/v1','workspaceId',NEW.workspace_id,'eventId',NEW.event_id,'recommendationSetId',NEW.recommendation_set_id,'versionNumber',NEW.version_number,'reviewerAccountId',NEW.reviewer_account_id,'reviewerPersonId',NEW.reviewer_person_id,'accountPersonBindingId',NEW.account_person_binding_id,'eventReviewerAssignmentId',NEW.event_reviewer_assignment_id,'eligibilityFingerprint',NEW.eligibility_fingerprint,'policyVersionId',NEW.policy_version_id,'policyVersionFingerprint',NEW.policy_version_fingerprint,'visibilityVersionId',NEW.visibility_version_id,'visibilityVersionFingerprint',NEW.visibility_version_fingerprint,'blindnessVersionId',NEW.blindness_version_id,'blindnessVersionFingerprint',NEW.blindness_version_fingerprint,'selectionContextVersionId',NEW.selection_context_version_id,'selectionContextFingerprint',NEW.selection_context_fingerprint,'selectionContextReference',NEW.selection_context_reference,'policyContextSchema',(SELECT context_schema FROM review_context_versions WHERE id=NEW.policy_version_id),'visibilityContextSchema',(SELECT context_schema FROM review_context_versions WHERE id=NEW.visibility_version_id),'blindnessContextSchema',(SELECT context_schema FROM review_context_versions WHERE id=NEW.blindness_version_id),'selectionContextSchema',(SELECT context_schema FROM review_context_versions WHERE id=NEW.selection_context_version_id),'maximumEntries',NEW.maximum_entries,'entries',(SELECT json_group_array(json_object('id',e.id,'submissionId',e.submission_id,'submissionRevisionId',e.submission_revision_id,'stance',e.stance,'rank',e.rank,'strength',e.strength,'rationale',e.rationale,'followUpWillingness',e.follow_up_willingness,'evidence',json(e.evidence_json))) FROM (SELECT * FROM recommendation_entries WHERE recommendation_set_version_id=NEW.id ORDER BY rank IS NULL,rank,id) e))))
BEGIN SELECT RAISE(ABORT, 'recommendation_set_versions is immutable or finalization mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_set_versions_no_delete BEFORE DELETE ON recommendation_set_versions BEGIN SELECT RAISE(ABORT, 'recommendation_set_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_entries_guard BEFORE INSERT ON recommendation_entries
WHEN NOT EXISTS (SELECT 1 FROM recommendation_set_versions v WHERE v.id=NEW.recommendation_set_version_id AND v.workspace_id=NEW.workspace_id AND v.event_id=NEW.event_id AND v.sealed_at IS NULL AND (SELECT COUNT(*) FROM recommendation_entries x WHERE x.recommendation_set_version_id=NEW.recommendATION_SET_VERSION_ID)<v.maximum_entries)
 OR NOT EXISTS (SELECT 1 FROM submissions s JOIN submission_revisions r ON r.id=NEW.submission_revision_id WHERE s.id=NEW.submission_id AND s.workspace_id=NEW.workspace_id AND s.event_id=NEW.event_id AND r.workspace_id=NEW.workspace_id AND r.submission_id=s.id)
 OR NOT EXISTS (SELECT 1 FROM review_context_versions p JOIN recommendation_set_versions v ON v.id=NEW.recommendation_set_version_id WHERE p.id=v.policy_version_id AND json_extract(p.context_json,'$.eligibleRevisions') IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(p.context_json,'$.eligibleRevisions') x WHERE json_extract(x.value,'$.submissionId')=NEW.submission_id AND json_extract(x.value,'$.submissionRevisionId')=NEW.submission_revision_id AND json_extract(x.value,'$.submissionRevisionFingerprint')=(SELECT fingerprint FROM submission_revisions WHERE id=NEW.submission_revision_id)))
 OR NOT EXISTS (SELECT 1 FROM review_context_versions p JOIN recommendation_set_versions v ON v.id=NEW.recommendATION_SET_VERSION_ID WHERE p.id=v.visibility_version_id AND EXISTS (SELECT 1 FROM json_each(p.context_json,'$.visibleRevisions') x WHERE json_extract(x.value,'$.submissionId')=NEW.submission_id AND json_extract(x.value,'$.submissionRevisionId')=NEW.submission_revision_id AND json_extract(x.value,'$.submissionRevisionFingerprint')=(SELECT fingerprint FROM submission_revisions WHERE id=NEW.submission_revision_id)))
 OR (NEW.evidence_json IS NOT NULL AND sympose_pd01_canonical_json(NEW.evidence_json) IS NOT NEW.evidence_json)
 OR (NEW.rank IS NOT NULL AND NEW.rank>(SELECT maximum_entries FROM recommendation_set_versions WHERE id=NEW.reCOMMENDATION_SET_VERSION_ID))
BEGIN SELECT RAISE(ABORT, 'recommendation_entries binding, eligibility, or visibility mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_entries_immutable BEFORE UPDATE ON recommendation_entries BEGIN SELECT RAISE(ABORT, 'recommendation_entries is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_recommendation_entries_no_delete BEFORE DELETE ON recommendation_entries BEGIN SELECT RAISE(ABORT, 'recommendation_entries is immutable'); END;
DROP INDEX IF EXISTS idx_recommendation_entries_revision;
DROP INDEX IF EXISTS idx_recommendation_versions_set;
CREATE INDEX idx_recommendation_versions_set ON recommendation_set_versions(workspace_id,event_id,recommendation_set_id,version_number);
CREATE INDEX idx_recommendation_entries_revision ON recommendation_entries(workspace_id,event_id,submission_revision_id);
`;

const v10AssignmentStateHistoryIsValid = (
  assignmentId: string,
  workspaceId: string,
  eventId: string,
): string => `
  EXISTS (
    SELECT 1
    FROM event_reviewer_assignments assignment
    WHERE assignment.id=${assignmentId}
      AND assignment.workspace_id=${workspaceId}
      AND assignment.event_id=${eventId}
  )
  AND EXISTS (
    SELECT 1
    FROM event_reviewer_assignment_states root
    WHERE root.event_reviewer_assignment_id=${assignmentId}
      AND root.workspace_id=${workspaceId}
      AND root.event_id=${eventId}
      AND root.sequence_number=1
      AND root.state='ACTIVE'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM event_reviewer_assignment_states state
    JOIN event_reviewer_assignments assignment
      ON assignment.id=state.event_reviewer_assignment_id
    WHERE state.event_reviewer_assignment_id=${assignmentId}
      AND (
        state.workspace_id IS NOT assignment.workspace_id
        OR state.event_id IS NOT assignment.event_id
        OR state.workspace_id IS NOT ${workspaceId}
        OR state.event_id IS NOT ${eventId}
        OR typeof(state.id) <> 'text'
        OR length(CAST(state.id AS BLOB)) NOT BETWEEN 1 AND 128
        OR instr(state.id, char(0)) > 0
        OR typeof(state.sequence_number) <> 'integer'
        OR state.sequence_number < 1
        OR state.sequence_number > 9007199254740991
        OR state.state IS NULL
        OR state.state NOT IN ('ACTIVE','REVOKED')
        OR state.created_at IS NULL
        OR NOT ${v9CanonicalInstantCheck("state.created_at")}
        OR state.created_at < assignment.created_at
        OR (state.reason IS NOT NULL AND (typeof(state.reason) <> 'text' OR length(CAST(state.reason AS BLOB)) NOT BETWEEN 1 AND 1024))
        OR NOT EXISTS (
          SELECT 1
          FROM accounts actor
          WHERE actor.id=state.actor_account_id
            AND actor.workspace_id=state.workspace_id
        )
        OR (state.sequence_number=1 AND state.state<>'ACTIVE')
        OR (state.sequence_number>1 AND NOT EXISTS (
          SELECT 1
          FROM event_reviewer_assignment_states prior
          WHERE prior.event_reviewer_assignment_id=state.event_reviewer_assignment_id
            AND prior.sequence_number=state.sequence_number-1
        ))
        OR (state.sequence_number>1 AND state.state IS (
          SELECT prior.state
          FROM event_reviewer_assignment_states prior
          WHERE prior.event_reviewer_assignment_id=state.event_reviewer_assignment_id
            AND prior.sequence_number=state.sequence_number-1
        ))
        OR (state.sequence_number>1 AND state.created_at < (
          SELECT prior.created_at
          FROM event_reviewer_assignment_states prior
          WHERE prior.event_reviewer_assignment_id=state.event_reviewer_assignment_id
            AND prior.sequence_number=state.sequence_number-1
        ))
      )
  )`;

const v10AssignmentActiveAt = (
  assignmentId: string,
  workspaceId: string,
  eventId: string,
  instant: string,
): string => `
  EXISTS (
    SELECT 1
    FROM event_reviewer_assignments assignment
    JOIN event_reviewer_assignment_states state
      ON state.event_reviewer_assignment_id=assignment.id
     AND state.workspace_id=assignment.workspace_id
     AND state.event_id=assignment.event_id
     AND state.sequence_number=(
       SELECT MAX(candidate.sequence_number)
       FROM event_reviewer_assignment_states candidate
       WHERE candidate.event_reviewer_assignment_id=assignment.id
         AND candidate.workspace_id=assignment.workspace_id
         AND candidate.event_id=assignment.event_id
         AND candidate.created_at <= ${instant}
     )
    WHERE assignment.id=${assignmentId}
      AND assignment.workspace_id=${workspaceId}
      AND assignment.event_id=${eventId}
      AND assignment.created_at <= ${instant}
      AND state.state='ACTIVE'
  )`;

const v9FinalizationTrigger = V9_DDL.match(
  /CREATE TRIGGER IF NOT EXISTS trg_recommendation_set_versions_finalize_or_immutable BEFORE UPDATE ON recommendation_set_versions[\s\S]*?BEGIN SELECT RAISE\(ABORT, 'recommendation_set_versions is immutable or finalization mismatch'\); END;/u,
)?.[0];
if (!v9FinalizationTrigger) {
  throw new Error("missing literal V9 recommendation finalization trigger");
}

const v10FinalizationTrigger = v9FinalizationTrigger.replace(
  /AND NEW\.submitted_at >= NEW\.created_at AND NEW\.sealed_at >= NEW\.submitted_at AND EXISTS \(SELECT 1 FROM event_reviewer_assignment_states st[\s\S]*?AND st\.state='ACTIVE'\) AND NEW\.content_fingerprint IS /u,
  `AND OLD.content_fingerprint IS NULL
    AND NEW.submitted_at >= NEW.created_at
    AND NEW.sealed_at >= NEW.submitted_at
    AND NEW.created_at >= (SELECT created_at FROM recommendation_sets WHERE id=NEW.recommendation_set_id)
    AND NEW.submitted_at >= (SELECT created_at FROM event_reviewer_assignments WHERE id=NEW.event_reviewer_assignment_id)
    AND ${v10AssignmentStateHistoryIsValid("NEW.event_reviewer_assignment_id", "NEW.workspace_id", "NEW.event_id")}
    AND ${v10AssignmentActiveAt("NEW.event_reviewer_assignment_id", "NEW.workspace_id", "NEW.event_id", "NEW.sealed_at")}
    AND NOT EXISTS (SELECT 1 FROM recommendation_entries entry WHERE entry.recommendation_set_version_id=NEW.id AND entry.created_at > NEW.sealed_at)
    AND NEW.content_fingerprint IS `,
);
if (v10FinalizationTrigger === v9FinalizationTrigger) {
  throw new Error("failed to strengthen V9 recommendation finalization trigger");
}

export const V10_DDL = `
DROP TRIGGER IF EXISTS trg_event_reviewer_assignments_guard;
CREATE TRIGGER trg_event_reviewer_assignments_guard BEFORE INSERT ON event_reviewer_assignments
WHEN NOT EXISTS (SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=NEW.reviewer_account_id AND a.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM people p WHERE p.id=NEW.reviewer_person_id AND p.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=NEW.assigned_by_account_id AND a.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM account_person_bindings b WHERE b.id=NEW.account_person_binding_id AND b.workspace_id=NEW.workspace_id AND b.account_id=NEW.reviewer_account_id AND b.person_id=NEW.reviewer_person_id)
 OR NEW.created_at < (SELECT created_at FROM account_person_bindings WHERE id=NEW.account_person_binding_id)
 OR sympose_pd01_fingerprint(json_object('schema','pd01-event-reviewer-assignment/v1','workspaceId',NEW.workspace_id,'eventId',NEW.event_id,'reviewerAccountId',NEW.reviewer_account_id,'reviewerPersonId',NEW.reviewer_person_id,'accountPersonBindingId',NEW.account_person_binding_id,'assignedByAccountId',NEW.assigned_by_account_id,'createdAt',NEW.created_at)) IS NOT NEW.fingerprint
BEGIN SELECT RAISE(ABORT, 'event_reviewer_assignments binding or chronology mismatch'); END;

DROP TRIGGER IF EXISTS trg_event_reviewer_assignment_states_guard;
CREATE TRIGGER trg_event_reviewer_assignment_states_guard BEFORE INSERT ON event_reviewer_assignment_states
WHEN NOT EXISTS (SELECT 1 FROM event_reviewer_assignments a WHERE a.id=NEW.event_reviewer_assignment_id AND a.workspace_id=NEW.workspace_id AND a.event_id=NEW.event_id)
 OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=NEW.actor_account_id AND a.workspace_id=NEW.workspace_id)
 OR NEW.sequence_number IS NOT COALESCE((SELECT MAX(sequence_number)+1 FROM event_reviewer_assignment_states WHERE event_reviewer_assignment_id=NEW.event_reviewer_assignment_id),1)
 OR NEW.sequence_number=1 AND NEW.state<>'ACTIVE'
 OR NEW.sequence_number>1 AND NEW.state IS (SELECT state FROM event_reviewer_assignment_states WHERE event_reviewer_assignment_id=NEW.event_reviewer_assignment_id AND sequence_number=NEW.sequence_number-1)
 OR NEW.created_at < (SELECT created_at FROM event_reviewer_assignments WHERE id=NEW.event_reviewer_assignment_id)
 OR NEW.sequence_number>1 AND NEW.created_at < (SELECT created_at FROM event_reviewer_assignment_states WHERE event_reviewer_assignment_id=NEW.event_reviewer_assignment_id AND sequence_number=NEW.sequence_number-1)
 OR EXISTS (SELECT 1 FROM recommendation_set_versions version WHERE version.event_reviewer_assignment_id=NEW.event_reviewer_assignment_id AND version.workspace_id=NEW.workspace_id AND version.event_id=NEW.event_id AND version.sealed_at IS NOT NULL AND NEW.created_at <= version.sealed_at)
BEGIN SELECT RAISE(ABORT, 'event_reviewer_assignment_states binding, sequence, chronology, or transition mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_v10_review_context_versions_maximum_entries_guard BEFORE INSERT ON review_context_versions
WHEN NEW.context_kind='ADVOCACY_POLICY'
 AND (json_type(NEW.context_json,'$.maximumEntries') IS NOT 'integer' OR json_extract(NEW.context_json,'$.maximumEntries') > 10000)
BEGIN SELECT RAISE(ABORT, 'review_context_versions maximumEntries bound mismatch'); END;

DROP TRIGGER IF EXISTS trg_recommendation_sets_guard;
CREATE TRIGGER trg_recommendation_sets_guard BEFORE INSERT ON recommendation_sets
WHEN NOT EXISTS (SELECT 1 FROM events e WHERE e.id=NEW.event_id AND e.workspace_id=NEW.workspace_id)
 OR NOT EXISTS (SELECT 1 FROM event_reviewer_assignments a WHERE a.id=NEW.event_reviewer_assignment_id AND a.workspace_id=NEW.workspace_id AND a.event_id=NEW.event_id AND a.reviewer_account_id=NEW.reviewer_account_id AND a.reviewer_person_id=NEW.reviewer_person_id AND a.account_person_binding_id=NEW.account_person_binding_id)
 OR NEW.created_at < (SELECT created_at FROM event_reviewer_assignments WHERE id=NEW.event_reviewer_assignment_id)
BEGIN SELECT RAISE(ABORT, 'recommendation_sets identity or chronology mismatch'); END;

DROP TRIGGER IF EXISTS trg_recommendation_set_versions_guard;
CREATE TRIGGER trg_recommendation_set_versions_guard BEFORE INSERT ON recommendation_set_versions
WHEN NOT EXISTS (SELECT 1 FROM recommendation_sets s WHERE s.id=NEW.recommendation_set_id AND s.workspace_id=NEW.workspace_id AND s.event_id=NEW.event_id AND s.reviewer_account_id=NEW.reviewer_account_id AND s.reviewer_person_id=NEW.reviewer_person_id AND s.event_reviewer_assignment_id=NEW.event_reviewer_assignment_id AND s.account_person_binding_id=NEW.account_person_binding_id)
 OR NEW.version_number IS NOT COALESCE((SELECT MAX(version_number)+1 FROM recommendation_set_versions WHERE workspace_id=NEW.workspace_id AND recommendation_set_id=NEW.recommendation_set_id),1)
 OR sympose_pd01_canonical_json(NEW.eligibility_snapshot_json) IS NOT NEW.eligibility_snapshot_json
 OR NEW.eligibility_fingerprint IS NOT sympose_pd01_fingerprint(NEW.eligibility_snapshot_json)
 OR NEW.maximum_entries IS NOT (SELECT json_extract(context_json, '$.maximumEntries') FROM review_context_versions WHERE id=NEW.policy_version_id)
 OR NEW.eligibility_snapshot_json IS NOT (SELECT sympose_pd01_canonical_json(json_extract(context_json, '$.eligibleRevisions')) FROM review_context_versions WHERE id=NEW.policy_version_id)
 OR NOT EXISTS (SELECT 1 FROM review_context_versions c WHERE c.id=NEW.policy_version_id AND c.workspace_id=NEW.workspace_id AND c.event_id=NEW.event_id AND c.context_kind='ADVOCACY_POLICY' AND c.fingerprint=NEW.policy_version_fingerprint)
 OR NOT EXISTS (SELECT 1 FROM review_context_versions c WHERE c.id=NEW.visibility_version_id AND c.workspace_id=NEW.workspace_id AND c.event_id=NEW.event_id AND c.context_kind='VISIBILITY' AND c.fingerprint=NEW.visibility_version_fingerprint)
 OR NOT EXISTS (SELECT 1 FROM review_context_versions c WHERE c.id=NEW.blindness_version_id AND c.workspace_id=NEW.workspace_id AND c.event_id=NEW.event_id AND c.context_kind='BLINDNESS' AND c.fingerprint=NEW.blindness_version_fingerprint)
 OR NOT EXISTS (SELECT 1 FROM review_context_versions c WHERE c.id=NEW.selection_context_version_id AND c.workspace_id=NEW.workspace_id AND c.event_id=NEW.event_id AND c.context_kind='SELECTION_CONTEXT' AND c.fingerprint=NEW.selection_context_fingerprint)
 OR NEW.selection_context_reference IS NOT (SELECT json_extract(context_json,'$.decisionBoundary') FROM review_context_versions WHERE id=NEW.selection_context_version_id)
 OR NEW.created_at < (SELECT created_at FROM recommendation_sets WHERE id=NEW.recommendation_set_id)
 OR NEW.created_at < (SELECT created_at FROM event_reviewer_assignments WHERE id=NEW.event_reviewer_assignment_id)
 OR NEW.submitted_at IS NOT NULL OR NEW.sealed_at IS NOT NULL OR NEW.content_fingerprint IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'recommendation_set_versions V10 binding mismatch'); END;

DROP TRIGGER IF EXISTS trg_recommendation_set_versions_finalize_or_immutable;
${v10FinalizationTrigger}

DROP TRIGGER IF EXISTS trg_recommendation_entries_guard;
CREATE TRIGGER trg_recommendation_entries_guard BEFORE INSERT ON recommendation_entries
WHEN NOT EXISTS (SELECT 1 FROM recommendation_set_versions v WHERE v.id=NEW.recommendation_set_version_id AND v.workspace_id=NEW.workspace_id AND v.event_id=NEW.event_id AND v.sealed_at IS NULL AND (SELECT COUNT(*) FROM recommendation_entries x WHERE x.recommendation_set_version_id=NEW.recommendation_set_version_id)<v.maximum_entries)
 OR NOT EXISTS (SELECT 1 FROM submissions s JOIN submission_revisions r ON r.id=NEW.submission_revision_id WHERE s.id=NEW.submission_id AND s.workspace_id=NEW.workspace_id AND s.event_id=NEW.event_id AND r.workspace_id=NEW.workspace_id AND r.submission_id=s.id)
 OR NOT EXISTS (SELECT 1 FROM review_context_versions p JOIN recommendation_set_versions v ON v.id=NEW.recommendation_set_version_id WHERE p.id=v.policy_version_id AND json_extract(p.context_json,'$.eligibleRevisions') IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(p.context_json,'$.eligibleRevisions') x WHERE json_extract(x.value,'$.submissionId')=NEW.submission_id AND json_extract(x.value,'$.submissionRevisionId')=NEW.submission_revision_id AND json_extract(x.value,'$.submissionRevisionFingerprint')=(SELECT fingerprint FROM submission_revisions WHERE id=NEW.submission_revision_id)))
 OR NOT EXISTS (SELECT 1 FROM review_context_versions p JOIN recommendation_set_versions v ON v.id=NEW.recommendATION_SET_VERSION_ID WHERE p.id=v.visibility_version_id AND EXISTS (SELECT 1 FROM json_each(p.context_json,'$.visibleRevisions') x WHERE json_extract(x.value,'$.submissionId')=NEW.submission_id AND json_extract(x.value,'$.submissionRevisionId')=NEW.submission_revision_id AND json_extract(x.value,'$.submissionRevisionFingerprint')=(SELECT fingerprint FROM submission_revisions WHERE id=NEW.submission_revision_id)))
 OR (NEW.evidence_json IS NOT NULL AND sympose_pd01_canonical_json(NEW.evidence_json) IS NOT NEW.evidence_json)
 OR (NEW.rank IS NOT NULL AND NEW.rank>(SELECT maximum_entries FROM recommendation_set_versions WHERE id=NEW.reCOMMENDATION_SET_VERSION_ID))
 OR NEW.created_at < (SELECT created_at FROM recommendation_set_versions WHERE id=NEW.recommendation_set_version_id)
BEGIN SELECT RAISE(ABORT, 'recommendation_entries binding, eligibility, visibility, or chronology mismatch'); END;
`;

const V7_BASE_DDL = V4_DDL.replace(
  V6_CFP_EMAIL_VERIFICATIONS_TABLE,
  V7_CFP_EMAIL_VERIFICATIONS_TABLE,
);

const V8_BASE_DDL = V7_BASE_DDL.replace(
  "   updated_at TEXT NOT NULL CHECK (updated_at >= created_at)\n );",
  "   updated_at TEXT NOT NULL CHECK (updated_at >= created_at)\n , lineage_id TEXT REFERENCES proposal_lineages(id));",
);

// V18 remains literal accepted history. V19 appends the trusted ingestion time to observations;
// SQLite ALTER TABLE preserves this exact fragment, so fresh and migrated databases converge.
export const V19_OBSERVATION_RECORDED_AT_COLUMN = "recorded_at TEXT";
const V19_BASE_DDL = V8_BASE_DDL.replace(
  "  corrected_by TEXT,\n  UNIQUE (workspace_id, idempotency_key)",
  `  corrected_by TEXT, ${V19_OBSERVATION_RECORDED_AT_COLUMN},\n  UNIQUE (workspace_id, idempotency_key)`,
);

function v9FreshV8Ddl(): string {
  let ddl = V8_DDL;
  for (const table of ["recommendation_sets", "recommendation_set_versions", "recommendation_entries"]) {
    const oldDefinition = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) STRICT;`);
    const v9Definition = V9_DDL.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) STRICT;`))?.[0];
    if (!v9Definition) throw new Error(`missing V9 table definition: ${table}`);
    ddl = ddl.replace(oldDefinition, v9Definition);
  }
  return ddl;
}

const v9ReviewContextVersionsTable = V9_DDL.match(
  /CREATE TABLE IF NOT EXISTS review_context_versions \([\s\S]*?\) STRICT;/u,
)?.[0];
if (!v9ReviewContextVersionsTable) {
  throw new Error("missing literal V9 review context versions table");
}

// V9 and V10 remain literal history. V11 narrows fingerprint uniqueness to the same
// event/context-kind lineage while retaining the existing version and immutable constraints.
export const V11_DDL = v9ReviewContextVersionsTable.replace(
  "  UNIQUE (workspace_id, fingerprint)",
  "  UNIQUE (workspace_id, event_id, context_kind, fingerprint)",
);

const v11FreshV9Ddl = V9_DDL.replace(v9ReviewContextVersionsTable, V11_DDL);

/**
 * V12 is deliberately additive. These tables are the shared local contracts for
 * the evaluator lifecycle; the existing Workspace, Person, Event, and
 * program_units roots remain authoritative.
 */
export const V12_DDL = `
CREATE TABLE IF NOT EXISTS event_speakers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  role_key TEXT NOT NULL DEFAULT 'SPEAKER',
  participation_status TEXT NOT NULL DEFAULT 'INVITED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, event_id, person_id, role_key),
  CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE IF NOT EXISTS event_tracks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, event_id, name),
  UNIQUE (workspace_id, event_id, slug)
) STRICT;

CREATE TABLE IF NOT EXISTS event_rooms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  capacity INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, event_id, name),
  CHECK (capacity IS NULL OR capacity > 0)
) STRICT;

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, payload_fingerprint)
) STRICT;

CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  domain_event_id TEXT NOT NULL REFERENCES domain_events(id),
  destination_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  claim_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT,
  UNIQUE (workspace_id, domain_event_id, destination_key),
  CHECK (attempt_count >= 0),
  CHECK (status IN ('PENDING', 'CLAIMED', 'DELIVERED', 'FAILED'))
) STRICT;

CREATE TABLE IF NOT EXISTS event_session_allocations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  program_unit_id TEXT NOT NULL REFERENCES program_units(id),
  room_id TEXT NOT NULL REFERENCES event_rooms(id),
  track_id TEXT REFERENCES event_tracks(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  allocation_status TEXT NOT NULL DEFAULT 'DRAFT',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, event_id, program_unit_id),
  CHECK (ends_at > starts_at),
  CHECK (updated_at >= created_at),
  CHECK (allocation_status IN ('DRAFT', 'PUBLISHED', 'CANCELLED'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_event_speakers_event_status
  ON event_speakers (workspace_id, event_id, participation_status);
CREATE INDEX IF NOT EXISTS idx_event_session_allocations_event_time
  ON event_session_allocations (workspace_id, event_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_outbox_messages_delivery
  ON outbox_messages (workspace_id, status, next_attempt_at, created_at);

CREATE TRIGGER IF NOT EXISTS trg_v12_event_speakers_workspace_guard
BEFORE INSERT ON event_speakers
WHEN NOT EXISTS (
  SELECT 1 FROM events e
  JOIN people p ON p.workspace_id=e.workspace_id
  WHERE e.id=NEW.event_id AND e.workspace_id=NEW.workspace_id AND p.id=NEW.person_id
)
BEGIN SELECT RAISE(ABORT, 'event_speakers workspace binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_event_speakers_workspace_update_guard
BEFORE UPDATE ON event_speakers
WHEN NEW.id != OLD.id
  OR NEW.workspace_id != OLD.workspace_id
  OR NEW.event_id != OLD.event_id
  OR NEW.person_id != OLD.person_id
  OR NEW.role_key != OLD.role_key
  OR NEW.created_at != OLD.created_at
  OR NEW.updated_at < OLD.updated_at
  OR NOT EXISTS (
    SELECT 1 FROM events e
    JOIN people p ON p.workspace_id=e.workspace_id
    WHERE e.id=NEW.event_id AND e.workspace_id=NEW.workspace_id AND p.id=NEW.person_id
  )
BEGIN SELECT RAISE(ABORT, 'event_speakers workspace update mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_event_tracks_workspace_guard
BEFORE INSERT ON event_tracks
WHEN NOT EXISTS (SELECT 1 FROM events WHERE id=NEW.event_id AND workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'event_tracks workspace binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_event_tracks_workspace_update_guard
BEFORE UPDATE ON event_tracks
WHEN NEW.id != OLD.id
  OR NEW.workspace_id != OLD.workspace_id
  OR NEW.event_id != OLD.event_id
  OR NEW.created_at != OLD.created_at
  OR NOT EXISTS (SELECT 1 FROM events WHERE id=NEW.event_id AND workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'event_tracks workspace update mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_event_rooms_workspace_guard
BEFORE INSERT ON event_rooms
WHEN NOT EXISTS (SELECT 1 FROM events WHERE id=NEW.event_id AND workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'event_rooms workspace binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_event_rooms_workspace_update_guard
BEFORE UPDATE ON event_rooms
WHEN NEW.id != OLD.id
  OR NEW.workspace_id != OLD.workspace_id
  OR NEW.event_id != OLD.event_id
  OR NEW.created_at != OLD.created_at
  OR NOT EXISTS (SELECT 1 FROM events WHERE id=NEW.event_id AND workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'event_rooms workspace update mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_domain_events_payload_guard
BEFORE INSERT ON domain_events
WHEN sympose_pd01_canonical_json(NEW.payload_json) IS NOT NEW.payload_json
  OR sympose_pd01_fingerprint(NEW.payload_json) IS NOT NEW.payload_fingerprint
BEGIN SELECT RAISE(ABORT, 'domain_events payload must be canonical and fingerprinted'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_domain_events_immutable
BEFORE UPDATE ON domain_events
BEGIN SELECT RAISE(ABORT, 'domain_events are immutable evidence'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_domain_events_no_delete
BEFORE DELETE ON domain_events
BEGIN SELECT RAISE(ABORT, 'domain_events are immutable evidence'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_outbox_workspace_guard
BEFORE INSERT ON outbox_messages
WHEN NOT EXISTS (
  SELECT 1 FROM domain_events
  WHERE id=NEW.domain_event_id AND workspace_id=NEW.workspace_id
)
  OR sympose_pd01_canonical_json(NEW.payload_json) IS NOT NEW.payload_json
BEGIN SELECT RAISE(ABORT, 'outbox message binding or payload mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_outbox_workspace_update_guard
BEFORE UPDATE ON outbox_messages
WHEN NEW.id != OLD.id
  OR NEW.workspace_id != OLD.workspace_id
  OR NEW.domain_event_id != OLD.domain_event_id
  OR NEW.destination_key != OLD.destination_key
  OR NEW.payload_json != OLD.payload_json
  OR NEW.created_at != OLD.created_at
  OR NOT EXISTS (
    SELECT 1 FROM domain_events
    WHERE id=NEW.domain_event_id AND workspace_id=NEW.workspace_id
  )
  OR sympose_pd01_canonical_json(NEW.payload_json) IS NOT NEW.payload_json
BEGIN SELECT RAISE(ABORT, 'outbox message workspace update mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_event_session_allocations_guard
BEFORE INSERT ON event_session_allocations
WHEN NOT EXISTS (
  SELECT 1 FROM events e
  JOIN program_units p ON p.event_id=e.id AND p.workspace_id=e.workspace_id
  JOIN event_rooms r ON r.event_id=e.id AND r.workspace_id=e.workspace_id
  WHERE e.id=NEW.event_id AND e.workspace_id=NEW.workspace_id
    AND p.id=NEW.program_unit_id AND r.id=NEW.room_id
)
  OR (NEW.track_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM event_tracks t
    WHERE t.id=NEW.track_id AND t.event_id=NEW.event_id AND t.workspace_id=NEW.workspace_id
  ))
  OR (
    NEW.allocation_status <> 'CANCELLED'
    AND EXISTS (
    SELECT 1 FROM event_session_allocations a
    WHERE a.workspace_id=NEW.workspace_id
      AND a.event_id=NEW.event_id
      AND a.room_id=NEW.room_id
      AND a.allocation_status <> 'CANCELLED'
      AND NEW.starts_at < a.ends_at
      AND NEW.ends_at > a.starts_at
    )
  )
BEGIN SELECT RAISE(ABORT, 'event_session_allocations binding or room conflict'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_event_session_allocations_update_guard
BEFORE UPDATE ON event_session_allocations
WHEN NEW.id != OLD.id
  OR NEW.workspace_id != OLD.workspace_id
  OR NEW.event_id != OLD.event_id
  OR NEW.program_unit_id != OLD.program_unit_id
  OR NEW.created_at != OLD.created_at
  OR NEW.updated_at < OLD.updated_at
  OR NOT EXISTS (
    SELECT 1 FROM events e
    JOIN program_units p ON p.event_id=e.id AND p.workspace_id=e.workspace_id
    JOIN event_rooms r ON r.event_id=e.id AND r.workspace_id=e.workspace_id
    WHERE e.id=NEW.event_id AND e.workspace_id=NEW.workspace_id
      AND p.id=NEW.program_unit_id AND r.id=NEW.room_id
  )
  OR (NEW.track_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM event_tracks t
    WHERE t.id=NEW.track_id AND t.event_id=NEW.event_id AND t.workspace_id=NEW.workspace_id
  ))
  OR (
    NEW.allocation_status <> 'CANCELLED'
    AND EXISTS (
      SELECT 1 FROM event_session_allocations a
      WHERE a.id != NEW.id
        AND a.workspace_id=NEW.workspace_id
        AND a.event_id=NEW.event_id
        AND a.room_id=NEW.room_id
        AND a.allocation_status <> 'CANCELLED'
        AND NEW.starts_at < a.ends_at
        AND NEW.ends_at > a.starts_at
    )
  )
BEGIN SELECT RAISE(ABORT, 'event_session_allocations workspace update or room conflict'); END;

CREATE TRIGGER IF NOT EXISTS trg_v12_event_speakers_no_delete
BEFORE DELETE ON event_speakers
BEGIN SELECT RAISE(ABORT, 'event_speakers participation history is retained'); END;
`;

const v4CfpSubmissionRevisionGuard = V4_DDL.match(
  /CREATE TRIGGER IF NOT EXISTS trg_cfp_submission_revisions_workspace_guard BEFORE INSERT ON submission_revisions[\s\S]*?BEGIN SELECT RAISE\(ABORT, 'submission_revisions workspace mismatch'\); END;/u,
)?.[0];
if (!v4CfpSubmissionRevisionGuard) {
  throw new Error("missing literal V4 CFP submission revision guard");
}

const v13CfpSubmissionRevisionGuard = v4CfpSubmissionRevisionGuard.replace(
  "    AND s.state = 'DRAFT'",
  `    AND (
      s.state = 'DRAFT'
      OR (
        s.state = 'SUBMITTED'
        AND c.state = 'OPEN'
        AND (c.opens_at IS NULL OR NEW.created_at >= c.opens_at)
        AND (c.closes_at IS NULL OR NEW.created_at < c.closes_at)
        AND NOT EXISTS (
          SELECT 1
          FROM domain_events decision_event
          WHERE decision_event.workspace_id = NEW.workspace_id
            AND decision_event.event_type = 'cfp.submission.decision'
            AND decision_event.aggregate_type = 'cfp_submission'
            AND decision_event.aggregate_id = NEW.submission_id
        )
        AND EXISTS (
          SELECT 1
          FROM cfp_submission_amendment_markers marker
          WHERE marker.workspace_id = NEW.workspace_id
            AND marker.call_id = s.call_id
            AND marker.submission_id = NEW.submission_id
            AND marker.person_id = NEW.person_id
            AND marker.session_id = NEW.session_id
            AND marker.expected_current_revision_id = s.current_revision_id
            AND marker.revision_id = NEW.id
            AND marker.created_at = NEW.created_at
        )
      )
    )`,
);

export const V13_DDL = `
CREATE TABLE IF NOT EXISTS cfp_submission_amendment_markers (
  id TEXT PRIMARY KEY,
  marker_schema TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  session_id TEXT NOT NULL REFERENCES cfp_applicant_sessions(id),
  expected_current_revision_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, revision_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_cfp_submission_amendment_markers_submission
  ON cfp_submission_amendment_markers (workspace_id, submission_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_cfp_submission_amendment_markers_guard
BEFORE INSERT ON cfp_submission_amendment_markers
WHEN typeof(NEW.id) IS NOT 'text'
  OR length(CAST(NEW.id AS BLOB)) NOT BETWEEN 1 AND 128
  OR NEW.id NOT GLOB '[A-Za-z0-9]*'
  OR NEW.id GLOB '*[^A-Za-z0-9._:-]*'
  OR typeof(NEW.revision_id) IS NOT 'text'
  OR length(CAST(NEW.revision_id AS BLOB)) NOT BETWEEN 1 AND 128
  OR NEW.revision_id NOT GLOB '[A-Za-z0-9]*'
  OR NEW.revision_id GLOB '*[^A-Za-z0-9._:-]*'
  OR typeof(NEW.expected_current_revision_id) IS NOT 'text'
  OR length(CAST(NEW.expected_current_revision_id AS BLOB)) NOT BETWEEN 1 AND 128
  OR NEW.expected_current_revision_id NOT GLOB '[A-Za-z0-9]*'
  OR NEW.expected_current_revision_id GLOB '*[^A-Za-z0-9._:-]*'
  OR NEW.marker_schema IS NOT 'cfp-submission-amendment/v1'
  OR NOT EXISTS (
    SELECT 1
    FROM submissions s
    JOIN calls c
      ON c.id = s.call_id
     AND c.workspace_id = s.workspace_id
    JOIN people p
      ON p.id = s.owner_person_id
     AND p.workspace_id = s.workspace_id
    JOIN cfp_applicant_sessions session_row
      ON session_row.id = NEW.session_id
     AND session_row.workspace_id = s.workspace_id
     AND session_row.call_id = s.call_id
     AND session_row.person_id = s.owner_person_id
    WHERE s.id = NEW.submission_id
      AND s.workspace_id = NEW.workspace_id
      AND s.call_id = NEW.call_id
      AND s.state = 'SUBMITTED'
      AND s.owner_person_id = NEW.person_id
      AND s.current_revision_id = NEW.expected_current_revision_id
      AND c.state = 'OPEN'
      AND (c.opens_at IS NULL OR NEW.created_at >= c.opens_at)
      AND (c.closes_at IS NULL OR NEW.created_at < c.closes_at)
      AND session_row.revoked_at IS NULL
      AND NEW.created_at >= session_row.created_at
      AND NEW.created_at < session_row.expires_at
      AND EXISTS (
        SELECT 1
        FROM cfp_email_verification_consumptions consumed
        WHERE consumed.workspace_id = session_row.workspace_id
          AND consumed.verification_id = session_row.verification_id
          AND consumed.person_id = session_row.person_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM submission_revisions existing_revision
        WHERE existing_revision.workspace_id = NEW.workspace_id
          AND existing_revision.id = NEW.revision_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM domain_events decision_event
        WHERE decision_event.workspace_id = NEW.workspace_id
          AND decision_event.event_type = 'cfp.submission.decision'
          AND decision_event.aggregate_type = 'cfp_submission'
          AND decision_event.aggregate_id = NEW.submission_id
      )
  )
BEGIN SELECT RAISE(ABORT, 'cfp submission amendment marker mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_submission_amendment_markers_immutable
BEFORE UPDATE ON cfp_submission_amendment_markers
BEGIN SELECT RAISE(ABORT, 'cfp submission amendment markers are immutable evidence'); END;

CREATE TRIGGER IF NOT EXISTS trg_cfp_submission_amendment_markers_no_delete
BEFORE DELETE ON cfp_submission_amendment_markers
BEGIN SELECT RAISE(ABORT, 'cfp submission amendment markers are retained'); END;

DROP TRIGGER IF EXISTS trg_cfp_submission_revisions_workspace_guard;
${v13CfpSubmissionRevisionGuard}
`;

function normalizedSpeakerRoleMatchSql(
  speakerAlias: string,
  assignmentAlias: string,
  offerAlias: string,
): string {
  return [
    "CASE " + speakerAlias + ".role_key",
    "  WHEN 'SPEAKER' THEN 'SPEAKER'",
    "  WHEN 'MODERATOR' THEN 'MODERATOR'",
    "END = CASE " + assignmentAlias + ".assignment_type",
    "  WHEN 'SPEAKER' THEN 'SPEAKER'",
    "  WHEN 'participant' THEN 'SPEAKER'",
    "  WHEN 'MODERATOR' THEN 'MODERATOR'",
    "  WHEN 'moderator' THEN 'MODERATOR'",
    "END",
    "AND CASE " + assignmentAlias + ".assignment_type",
    "  WHEN 'SPEAKER' THEN 'SPEAKER'",
    "  WHEN 'participant' THEN 'SPEAKER'",
    "  WHEN 'MODERATOR' THEN 'MODERATOR'",
    "  WHEN 'moderator' THEN 'MODERATOR'",
    "END = CASE json_extract(" + offerAlias + ".terms_json, '$.role')",
    "  WHEN 'SPEAKER' THEN 'SPEAKER'",
    "  WHEN 'participant' THEN 'SPEAKER'",
    "  WHEN 'MODERATOR' THEN 'MODERATOR'",
    "  WHEN 'moderator' THEN 'MODERATOR'",
    "END",
  ].join("\n");
}

function v15StrictZonedTimestampCheck(column: string): string {
  return `(
    typeof(${column}) = 'text'
    AND length(CAST(${column} AS BLOB)) IN (20, 22, 23, 24, 25, 27, 28, 29)
    AND substr(${column}, 5, 1) = '-'
    AND substr(${column}, 8, 1) = '-'
    AND substr(${column}, 11, 1) = 'T'
    AND substr(${column}, 14, 1) = ':'
    AND substr(${column}, 17, 1) = ':'
    AND substr(${column}, 1, 4) NOT GLOB '*[^0-9]*'
    AND substr(${column}, 6, 2) NOT GLOB '*[^0-9]*'
    AND substr(${column}, 9, 2) NOT GLOB '*[^0-9]*'
    AND substr(${column}, 12, 2) NOT GLOB '*[^0-9]*'
    AND substr(${column}, 15, 2) NOT GLOB '*[^0-9]*'
    AND substr(${column}, 18, 2) NOT GLOB '*[^0-9]*'
    AND CAST(substr(${column}, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(${column}, 9, 2) AS INTEGER) BETWEEN 1 AND 31
    AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
    AND strftime('%Y-%m-%d', substr(${column}, 1, 10)) IS substr(${column}, 1, 10)
    AND (
      (
        substr(${column}, -1) = 'Z'
        AND (
          length(CAST(${column} AS BLOB)) = 20
          OR (
            substr(${column}, 20, 1) = '.'
            AND length(CAST(${column} AS BLOB)) BETWEEN 22 AND 24
            AND substr(${column}, 21, length(${column}) - 21) NOT GLOB '*[^0-9]*'
          )
        )
      )
      OR (
        substr(${column}, -6, 1) IN ('+', '-')
        AND substr(${column}, -3, 1) = ':'
        AND substr(${column}, -5, 2) NOT GLOB '*[^0-9]*'
        AND substr(${column}, -2, 2) NOT GLOB '*[^0-9]*'
        AND CAST(substr(${column}, -5, 2) AS INTEGER) BETWEEN 0 AND 23
        AND CAST(substr(${column}, -2, 2) AS INTEGER) BETWEEN 0 AND 59
        AND (
          length(CAST(${column} AS BLOB)) = 25
          OR (
            substr(${column}, 20, 1) = '.'
            AND length(CAST(${column} AS BLOB)) BETWEEN 27 AND 29
            AND substr(${column}, 21, length(${column}) - 26) NOT GLOB '*[^0-9]*'
          )
        )
      )
    )
    AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL
  )`;
}

function v15CanonicalTimestampCheck(column: string): string {
  return `(
    ${v15StrictZonedTimestampCheck(column)}
    AND length(CAST(${column} AS BLOB)) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS ${column}
  )`;
}

/**
 * V14 is the first real local immutable artifact contract. Artifact bytes remain in the bounded
 * local store, while task authority, content versions, review decisions, upload intent, and
 * accepted metadata are durable SQLite truth. The intent is deliberately narrow: it is a
 * recoverable two-phase journal for this local artifact vertical, not a provider abstraction.
 */
export const V14_DDL = `
CREATE TABLE IF NOT EXISTS speaker_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  assignment_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  content_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  required INTEGER NOT NULL,
  gate TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'NOT_STARTED',
  due_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, event_id, person_id, id),
  CHECK (length(CAST(id AS BLOB)) BETWEEN 1 AND 128 AND id NOT GLOB '*[' || char(0) || '-' || char(31) || ']*'),
  CHECK (task_kind IN ('HEADSHOT', 'SLIDES')),
  CHECK (content_kind IN ('HEADSHOT', 'SLIDES')),
  CHECK (task_kind = content_kind),
  CHECK (length(CAST(title AS BLOB)) BETWEEN 1 AND 240),
  CHECK (required IN (0, 1)),
  CHECK (gate IN ('PUBLICATION', 'OPERATOR_RELEASE')),
  CHECK (owner = 'SPEAKER'),
  CHECK (state IN ('NOT_STARTED', 'SUBMITTED', 'COMPLETED', 'CHANGES_REQUESTED', 'BLOCKED')),
  CHECK (length(CAST(due_at AS BLOB)) BETWEEN 1 AND 80),
  CHECK (length(CAST(created_at AS BLOB)) BETWEEN 1 AND 128),
  CHECK (length(CAST(updated_at AS BLOB)) BETWEEN 1 AND 128 AND updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_speaker_tasks_scope
  ON speaker_tasks (workspace_id, event_id, person_id, task_kind);

CREATE TRIGGER IF NOT EXISTS trg_speaker_tasks_scope_guard
BEFORE INSERT ON speaker_tasks
WHEN NOT EXISTS (
  SELECT 1
  FROM events e
  JOIN plan_versions plan ON plan.id = e.current_plan_version_id
    AND plan.workspace_id = e.workspace_id AND plan.event_id = e.id
  JOIN plan_assignments assignment ON assignment.plan_version_id = plan.id
    AND assignment.workspace_id = plan.workspace_id AND assignment.person_id = NEW.person_id
  JOIN event_speakers accepted_speaker ON accepted_speaker.workspace_id = plan.workspace_id
    AND accepted_speaker.event_id = e.id AND accepted_speaker.person_id = assignment.person_id
    AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')
    AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')
  JOIN program_units unit ON unit.id = assignment.program_unit_id
    AND unit.workspace_id = assignment.workspace_id AND unit.event_id = e.id
  JOIN approvals approval ON approval.plan_version_id = plan.id
    AND approval.workspace_id = plan.workspace_id AND approval.event_id = e.id
    AND approval.decision = 'approved'
  JOIN plan_states current_state ON current_state.plan_version_id = plan.id
    AND current_state.workspace_id = plan.workspace_id
    AND current_state.state = 'approved'
    AND NOT EXISTS (
      SELECT 1 FROM plan_states newer_state
      WHERE newer_state.workspace_id = current_state.workspace_id
        AND newer_state.plan_version_id = current_state.plan_version_id
        AND (newer_state.created_at > current_state.created_at
          OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))
    )
    AND NOT EXISTS (
      SELECT 1 FROM plan_states superseded_state
      WHERE superseded_state.workspace_id = plan.workspace_id
        AND superseded_state.plan_version_id = plan.id
        AND superseded_state.state = 'superseded'
    )
  JOIN commitment_offers offer ON offer.plan_version_id = plan.id
    AND offer.workspace_id = plan.workspace_id AND offer.event_id = e.id
    AND offer.person_id = assignment.person_id
  JOIN commitment_responses response ON response.offer_id = offer.id
    AND response.workspace_id = offer.workspace_id AND response.actor_person_id = offer.person_id
    AND response.response = 'accepted'
  WHERE json_extract(offer.terms_json, '$.planVersionId') = plan.id
    AND json_extract(offer.terms_json, '$.eventId') = e.id
    AND json_extract(offer.terms_json, '$.programUnitId') = assignment.program_unit_id
    AND ${normalizedSpeakerRoleMatchSql("accepted_speaker", "assignment", "offer")}
    AND (SELECT COUNT(*) FROM event_speakers accepted_scope_speaker
         WHERE accepted_scope_speaker.workspace_id = plan.workspace_id
           AND accepted_scope_speaker.event_id = e.id
           AND accepted_scope_speaker.person_id = assignment.person_id
           AND accepted_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')
           AND accepted_scope_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) = 1
    AND (SELECT COUNT(*) FROM plan_assignments current_assignment
         WHERE current_assignment.workspace_id = plan.workspace_id
           AND current_assignment.plan_version_id = plan.id
           AND current_assignment.person_id = assignment.person_id) = 1
    AND e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
  GROUP BY e.id
  HAVING COUNT(DISTINCT assignment.id) = 1
     AND COUNT(DISTINCT accepted_speaker.id) = 1
     AND COUNT(DISTINCT offer.id) = 1
     AND COUNT(DISTINCT response.id) = 1
     AND MIN(assignment.id) = NEW.assignment_id
)
OR NOT EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id)
OR NOT EXISTS (SELECT 1 FROM people p WHERE p.id = NEW.person_id AND p.workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'speaker_tasks scope or acceptance mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_tasks_reopen_authority_guard
BEFORE UPDATE ON speaker_tasks
WHEN NOT EXISTS (
  SELECT 1
  FROM events e
  JOIN plan_versions plan ON plan.id = e.current_plan_version_id
    AND plan.workspace_id = e.workspace_id AND plan.event_id = e.id
  JOIN plan_assignments assignment ON assignment.plan_version_id = plan.id
    AND assignment.workspace_id = plan.workspace_id AND assignment.person_id = NEW.person_id
  JOIN event_speakers accepted_speaker ON accepted_speaker.workspace_id = plan.workspace_id
    AND accepted_speaker.event_id = e.id AND accepted_speaker.person_id = assignment.person_id
    AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')
    AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')
  JOIN program_units unit ON unit.id = assignment.program_unit_id
    AND unit.workspace_id = assignment.workspace_id AND unit.event_id = e.id
  JOIN approvals approval ON approval.plan_version_id = plan.id
    AND approval.workspace_id = plan.workspace_id AND approval.event_id = e.id
    AND approval.decision = 'approved'
  JOIN plan_states current_state ON current_state.plan_version_id = plan.id
    AND current_state.workspace_id = plan.workspace_id
    AND current_state.state = 'approved'
    AND NOT EXISTS (
      SELECT 1 FROM plan_states newer_state
      WHERE newer_state.workspace_id = current_state.workspace_id
        AND newer_state.plan_version_id = current_state.plan_version_id
        AND (newer_state.created_at > current_state.created_at
          OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))
    )
    AND NOT EXISTS (
      SELECT 1 FROM plan_states superseded_state
      WHERE superseded_state.workspace_id = plan.workspace_id
        AND superseded_state.plan_version_id = plan.id
        AND superseded_state.state = 'superseded'
    )
  JOIN commitment_offers offer ON offer.plan_version_id = plan.id
    AND offer.workspace_id = plan.workspace_id AND offer.event_id = e.id
    AND offer.person_id = assignment.person_id
  JOIN commitment_responses response ON response.offer_id = offer.id
    AND response.workspace_id = offer.workspace_id AND response.actor_person_id = offer.person_id
    AND response.response = 'accepted'
  WHERE json_extract(offer.terms_json, '$.planVersionId') = plan.id
    AND json_extract(offer.terms_json, '$.eventId') = e.id
    AND json_extract(offer.terms_json, '$.programUnitId') = assignment.program_unit_id
    AND ${normalizedSpeakerRoleMatchSql("accepted_speaker", "assignment", "offer")}
    AND (SELECT COUNT(*) FROM event_speakers accepted_scope_speaker
         WHERE accepted_scope_speaker.workspace_id = plan.workspace_id
           AND accepted_scope_speaker.event_id = e.id
           AND accepted_scope_speaker.person_id = assignment.person_id
           AND accepted_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')
           AND accepted_scope_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) = 1
    AND (SELECT COUNT(*) FROM plan_assignments current_assignment
         WHERE current_assignment.workspace_id = plan.workspace_id
           AND current_assignment.plan_version_id = plan.id
           AND current_assignment.person_id = assignment.person_id) = 1
    AND e.id = NEW.event_id AND e.workspace_id = NEW.workspace_id
  GROUP BY e.id
  HAVING COUNT(DISTINCT assignment.id) = 1
     AND COUNT(DISTINCT accepted_speaker.id) = 1
     AND COUNT(DISTINCT offer.id) = 1
     AND COUNT(DISTINCT response.id) = 1
     AND MIN(assignment.id) = NEW.assignment_id
)
BEGIN SELECT RAISE(ABORT, 'speaker_tasks reopen authority mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_tasks_immutable_definition
BEFORE UPDATE ON speaker_tasks
WHEN NEW.id != OLD.id
  OR NEW.workspace_id != OLD.workspace_id
  OR NEW.event_id != OLD.event_id
  OR NEW.person_id != OLD.person_id
  OR NEW.assignment_id != OLD.assignment_id
  OR NEW.task_kind != OLD.task_kind
  OR NEW.content_kind != OLD.content_kind
  OR NEW.title != OLD.title
  OR NEW.required != OLD.required
  OR NEW.gate != OLD.gate
  OR NEW.owner != OLD.owner
  OR NEW.created_at != OLD.created_at
  OR NEW.due_at != OLD.due_at
  OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'speaker_tasks definition is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_tasks_no_delete
BEFORE DELETE ON speaker_tasks
BEGIN SELECT RAISE(ABORT, 'speaker_tasks are retained'); END;

CREATE TABLE IF NOT EXISTS speaker_content_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  task_id TEXT NOT NULL REFERENCES speaker_tasks(id),
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  supersedes_version_id TEXT REFERENCES speaker_content_versions(id),
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  submitted_by_kind TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local-artifact-store',
  UNIQUE (workspace_id, event_id, person_id, task_id, kind, version),
  CHECK (kind IN ('HEADSHOT', 'SLIDES')),
  CHECK (version > 0),
  CHECK (length(CAST(content_hash AS BLOB)) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (payload_bytes BETWEEN 1 AND 4096),
  CHECK (payload_bytes = length(CAST(payload_json AS BLOB))),
  CHECK (submitted_by_kind = 'speaker'),
  CHECK (source = 'local-artifact-store'),
  CHECK (length(CAST(submitted_at AS BLOB)) BETWEEN 1 AND 128)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_speaker_content_versions_scope
  ON speaker_content_versions (workspace_id, event_id, person_id, task_id, kind, version);

CREATE TRIGGER IF NOT EXISTS trg_speaker_content_versions_payload_guard
BEFORE INSERT ON speaker_content_versions
WHEN sympose_pd01_canonical_json(NEW.payload_json) IS NOT NEW.payload_json
  OR sympose_pd01_fingerprint(NEW.payload_json) IS NOT NEW.content_hash
  OR COALESCE(json_type(NEW.payload_json, '$.kind'), '') <> 'text'
  OR COALESCE(json_type(NEW.payload_json, '$.asset.assetId'), '') <> 'text'
  OR COALESCE(json_type(NEW.payload_json, '$.asset.byteSize'), '') <> 'integer'
  OR COALESCE(json_type(NEW.payload_json, '$.asset.checksum'), '') <> 'text'
  OR COALESCE(json_type(NEW.payload_json, '$.asset.fileName'), '') <> 'text'
  OR COALESCE(json_type(NEW.payload_json, '$.asset.mediaType'), '') <> 'text'
  OR COALESCE(json_type(NEW.payload_json, '$.asset.storageRef'), '') <> 'text'
  OR json_extract(NEW.payload_json, '$.kind') IS NOT NEW.kind
  OR length(CAST(json_extract(NEW.payload_json, '$.asset.assetId') AS BLOB)) <> 64
  OR json_extract(NEW.payload_json, '$.asset.assetId') GLOB '*[^0-9a-f]*'
  OR length(CAST(json_extract(NEW.payload_json, '$.asset.checksum') AS BLOB)) <> 64
  OR json_extract(NEW.payload_json, '$.asset.checksum') GLOB '*[^0-9a-f]*'
  OR ((NEW.kind = 'HEADSHOT' AND (json_extract(NEW.payload_json, '$.asset.byteSize') NOT BETWEEN 1 AND 8388608 OR json_extract(NEW.payload_json, '$.asset.mediaType') IS NOT 'image/png' OR lower(json_extract(NEW.payload_json, '$.asset.fileName')) NOT LIKE '%.png'))
   OR (NEW.kind = 'SLIDES' AND (json_extract(NEW.payload_json, '$.asset.byteSize') NOT BETWEEN 1 AND 26214400 OR json_extract(NEW.payload_json, '$.asset.mediaType') IS NOT 'application/pdf' OR lower(json_extract(NEW.payload_json, '$.asset.fileName')) NOT LIKE '%.pdf')))
  OR length(CAST(json_extract(NEW.payload_json, '$.asset.fileName') AS BLOB)) NOT BETWEEN 1 AND 180
  OR json_extract(NEW.payload_json, '$.asset.fileName') LIKE '%/%'
  OR json_extract(NEW.payload_json, '$.asset.fileName') LIKE '%\\%'
  OR json_extract(NEW.payload_json, '$.asset.fileName') GLOB '*[' || char(0) || '-' || char(31) || ']*'
  OR json_extract(NEW.payload_json, '$.asset.storageRef') IS NOT ('synthetic://artifact/' || json_extract(NEW.payload_json, '$.asset.assetId'))
  OR sympose_pd01_canonical_json(json_object(
      'asset', json_object(
        'assetId', json_extract(NEW.payload_json, '$.asset.assetId'),
        'byteSize', json_extract(NEW.payload_json, '$.asset.byteSize'),
        'checksum', json_extract(NEW.payload_json, '$.asset.checksum'),
        'fileName', json_extract(NEW.payload_json, '$.asset.fileName'),
        'mediaType', json_extract(NEW.payload_json, '$.asset.mediaType'),
        'storageRef', json_extract(NEW.payload_json, '$.asset.storageRef')),
      'kind', json_extract(NEW.payload_json, '$.kind'))) IS NOT NEW.payload_json
  OR NOT EXISTS (
    SELECT 1 FROM speaker_tasks task
    WHERE task.id = NEW.task_id
      AND task.workspace_id = NEW.workspace_id
      AND task.event_id = NEW.event_id
      AND task.person_id = NEW.person_id
      AND task.content_kind = NEW.kind
  )
  OR NOT ${speakerTaskAuthorityExistsSql("NEW.task_id", "NEW.workspace_id", "NEW.event_id", "NEW.person_id", "NEW.kind")}
BEGIN SELECT RAISE(ABORT, 'speaker_content_versions binding or payload mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_content_versions_lineage_guard
BEFORE INSERT ON speaker_content_versions
WHEN (NEW.version = 1 AND NEW.supersedes_version_id IS NOT NULL)
  OR (NEW.version > 1 AND NOT EXISTS (
    SELECT 1 FROM speaker_content_versions prior
    WHERE prior.id = NEW.supersedes_version_id
      AND prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id
      AND prior.person_id = NEW.person_id
      AND prior.task_id = NEW.task_id
      AND prior.kind = NEW.kind
      AND prior.version = NEW.version - 1
  ))
BEGIN SELECT RAISE(ABORT, 'speaker_content_versions lineage mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_content_versions_immutable
BEFORE UPDATE ON speaker_content_versions
BEGIN SELECT RAISE(ABORT, 'speaker_content_versions are immutable evidence'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_content_versions_no_delete
BEFORE DELETE ON speaker_content_versions
BEGIN SELECT RAISE(ABORT, 'speaker_content_versions are retained'); END;

CREATE TABLE IF NOT EXISTS speaker_content_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  task_id TEXT NOT NULL REFERENCES speaker_tasks(id),
  submission_version_id TEXT NOT NULL REFERENCES speaker_content_versions(id),
  submission_content_hash TEXT NOT NULL,
  review_state TEXT NOT NULL,
  gate TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  UNIQUE (workspace_id, submission_version_id, review_state, gate),
  CHECK (length(CAST(submission_content_hash AS BLOB)) = 64 AND submission_content_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (review_state IN ('APPROVED', 'CHANGES_REQUESTED', 'BLOCKED')),
  CHECK (gate IN ('CONFIRMATION', 'PUBLICATION', 'OPERATOR_RELEASE')),
  CHECK (length(CAST(reviewed_at AS BLOB)) BETWEEN 1 AND 128)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_speaker_content_reviews_scope
  ON speaker_content_reviews (workspace_id, event_id, person_id, task_id, submission_version_id);

CREATE TRIGGER IF NOT EXISTS trg_speaker_content_reviews_guard
BEFORE INSERT ON speaker_content_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM speaker_content_versions version
  WHERE version.id = NEW.submission_version_id
    AND version.workspace_id = NEW.workspace_id
    AND version.event_id = NEW.event_id
    AND version.person_id = NEW.person_id
    AND version.task_id = NEW.task_id
    AND version.content_hash = NEW.submission_content_hash
)
BEGIN SELECT RAISE(ABORT, 'speaker_content_reviews binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_content_reviews_immutable
BEFORE UPDATE ON speaker_content_reviews
BEGIN SELECT RAISE(ABORT, 'speaker_content_reviews are immutable evidence'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_content_reviews_no_delete
BEFORE DELETE ON speaker_content_reviews
BEGIN SELECT RAISE(ABORT, 'speaker_content_reviews are retained'); END;

CREATE TABLE IF NOT EXISTS speaker_portal_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  revoked_by TEXT,
  CHECK (length(CAST(token_hash AS BLOB)) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (purpose = 'speaker-content'),
  CHECK (length(CAST(created_at AS BLOB)) BETWEEN 1 AND 128),
  CHECK (length(CAST(expires_at AS BLOB)) BETWEEN 1 AND 128 AND expires_at > created_at),
  CHECK (revoked_at IS NULL OR length(CAST(revoked_at AS BLOB)) BETWEEN 1 AND 128)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_speaker_portal_tokens_scope
  ON speaker_portal_tokens (workspace_id, event_id, person_id, expires_at);

CREATE TRIGGER IF NOT EXISTS trg_speaker_portal_tokens_scope_guard
BEFORE INSERT ON speaker_portal_tokens
WHEN NOT EXISTS (
  SELECT 1 FROM event_speakers speaker
  WHERE speaker.workspace_id = NEW.workspace_id
    AND speaker.event_id = NEW.event_id
    AND speaker.person_id = NEW.person_id
    AND speaker.role_key IN ('SPEAKER', 'MODERATOR')
    AND speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')
  )
OR (SELECT COUNT(*) FROM event_speakers accepted_scope_speaker
    WHERE accepted_scope_speaker.workspace_id = NEW.workspace_id
      AND accepted_scope_speaker.event_id = NEW.event_id
      AND accepted_scope_speaker.person_id = NEW.person_id
      AND accepted_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')
      AND accepted_scope_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) <> 1
BEGIN SELECT RAISE(ABORT, 'speaker_portal_tokens scope or acceptance mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_portal_tokens_core_immutable
BEFORE UPDATE ON speaker_portal_tokens
WHEN NEW.id != OLD.id
  OR NEW.workspace_id != OLD.workspace_id
  OR NEW.event_id != OLD.event_id
  OR NEW.person_id != OLD.person_id
  OR NEW.token_hash != OLD.token_hash
  OR NEW.purpose != OLD.purpose
  OR NEW.created_at != OLD.created_at
  OR NEW.expires_at != OLD.expires_at
  OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at != OLD.revoked_at OR NEW.revoked_reason != OLD.revoked_reason OR NEW.revoked_by != OLD.revoked_by))
BEGIN SELECT RAISE(ABORT, 'speaker_portal_tokens core fields are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_portal_tokens_no_delete
BEFORE DELETE ON speaker_portal_tokens
BEGIN SELECT RAISE(ABORT, 'speaker_portal_tokens are retained'); END;

CREATE TABLE IF NOT EXISTS artifact_upload_intents (
  id TEXT PRIMARY KEY,
  intent_schema TEXT NOT NULL DEFAULT 'sympose-artifact-upload-intent/v1',
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  task_id TEXT NOT NULL REFERENCES speaker_tasks(id),
  kind TEXT NOT NULL,
  artifact_id TEXT NOT NULL UNIQUE,
  storage_id TEXT NOT NULL UNIQUE,
  storage_filename TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  supersedes_record_id TEXT,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  display_filename TEXT NOT NULL,
  created_at TEXT NOT NULL,
  content_version_id TEXT NOT NULL UNIQUE,
  content_payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREPARED',
  committed_at TEXT,
  UNIQUE (workspace_id, event_id, person_id, task_id, kind, version),
  CHECK (intent_schema = 'sympose-artifact-upload-intent/v1'),
  CHECK (length(CAST(id AS BLOB)) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  CHECK (kind IN ('HEADSHOT', 'SLIDES')),
  CHECK (length(CAST(artifact_id AS BLOB)) = 64 AND artifact_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(CAST(storage_id AS BLOB)) = 64 AND storage_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (storage_filename = storage_id || '.bin'),
  CHECK (storage_filename NOT LIKE '%/%' AND storage_filename NOT LIKE '%\\%'),
  CHECK (version > 0),
  CHECK (length(CAST(sha256 AS BLOB)) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK ((kind = 'HEADSHOT' AND size_bytes BETWEEN 1 AND 8388608) OR (kind = 'SLIDES' AND size_bytes BETWEEN 1 AND 26214400)),
  CHECK ((kind = 'HEADSHOT' AND media_type = 'image/png') OR (kind = 'SLIDES' AND media_type = 'application/pdf')),
  CHECK ((kind = 'HEADSHOT' AND lower(display_filename) LIKE '%.png') OR (kind = 'SLIDES' AND lower(display_filename) LIKE '%.pdf')),
  CHECK (length(CAST(display_filename AS BLOB)) BETWEEN 1 AND 180),
  CHECK (display_filename NOT LIKE '%/%' AND display_filename NOT LIKE '%\\%'),
  CHECK (display_filename NOT GLOB '*[' || char(0) || '-' || char(31) || ']*'),
  CHECK (length(CAST(created_at AS BLOB)) BETWEEN 1 AND 128),
  CHECK (status IN ('PREPARED', 'COMMITTED', 'ABORTED')),
  CHECK (committed_at IS NULL OR length(CAST(committed_at AS BLOB)) BETWEEN 1 AND 128)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_artifact_upload_intents_recovery
  ON artifact_upload_intents (status, created_at);

CREATE TRIGGER IF NOT EXISTS trg_artifact_upload_intents_payload_guard
BEFORE INSERT ON artifact_upload_intents
WHEN sympose_pd01_canonical_json(NEW.content_payload_json) IS NOT NEW.content_payload_json
  OR sympose_pd01_canonical_json(json_object(
      'asset', json_object(
        'assetId', json_extract(NEW.content_payload_json, '$.asset.assetId'),
        'byteSize', json_extract(NEW.content_payload_json, '$.asset.byteSize'),
        'checksum', json_extract(NEW.content_payload_json, '$.asset.checksum'),
        'fileName', json_extract(NEW.content_payload_json, '$.asset.fileName'),
        'mediaType', json_extract(NEW.content_payload_json, '$.asset.mediaType'),
        'storageRef', json_extract(NEW.content_payload_json, '$.asset.storageRef')),
      'kind', json_extract(NEW.content_payload_json, '$.kind'))) IS NOT NEW.content_payload_json
  OR json_extract(NEW.content_payload_json, '$.kind') IS NOT NEW.kind
  OR json_extract(NEW.content_payload_json, '$.asset.assetId') IS NOT NEW.artifact_id
  OR json_extract(NEW.content_payload_json, '$.asset.fileName') IS NOT NEW.display_filename
  OR json_extract(NEW.content_payload_json, '$.asset.mediaType') IS NOT NEW.media_type
  OR json_extract(NEW.content_payload_json, '$.asset.byteSize') IS NOT NEW.size_bytes
  OR json_extract(NEW.content_payload_json, '$.asset.checksum') IS NOT NEW.sha256
  OR json_extract(NEW.content_payload_json, '$.asset.storageRef') IS NOT ('synthetic://artifact/' || NEW.artifact_id)
  OR NOT EXISTS (
    SELECT 1 FROM speaker_tasks task
    WHERE task.id = NEW.task_id
      AND task.workspace_id = NEW.workspace_id
      AND task.event_id = NEW.event_id
      AND task.person_id = NEW.person_id
      AND task.content_kind = NEW.kind
  )
  OR NOT ${speakerTaskAuthorityExistsSql("NEW.task_id", "NEW.workspace_id", "NEW.event_id", "NEW.person_id", "NEW.kind")}
BEGIN SELECT RAISE(ABORT, 'artifact_upload_intents binding or payload mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_artifact_upload_intents_immutable
BEFORE UPDATE ON artifact_upload_intents
WHEN NEW.id != OLD.id
  OR NEW.intent_schema != OLD.intent_schema
  OR NEW.workspace_id != OLD.workspace_id
  OR NEW.event_id != OLD.event_id
  OR NEW.person_id != OLD.person_id
  OR NEW.task_id != OLD.task_id
  OR NEW.kind != OLD.kind
  OR NEW.artifact_id != OLD.artifact_id
  OR NEW.storage_id != OLD.storage_id
  OR NEW.storage_filename != OLD.storage_filename
  OR NEW.version != OLD.version
  OR COALESCE(NEW.supersedes_record_id, '') != COALESCE(OLD.supersedes_record_id, '')
  OR NEW.sha256 != OLD.sha256
  OR NEW.size_bytes != OLD.size_bytes
  OR NEW.media_type != OLD.media_type
  OR NEW.display_filename != OLD.display_filename
  OR NEW.created_at != OLD.created_at
  OR NEW.content_version_id != OLD.content_version_id
  OR NEW.content_payload_json != OLD.content_payload_json
  OR (OLD.status = 'ABORTED' AND NEW.status != OLD.status)
  OR (OLD.status = 'COMMITTED' AND (NEW.status != OLD.status OR NEW.committed_at != OLD.committed_at))
  OR (OLD.status = 'PREPARED' AND NEW.status = 'COMMITTED' AND NEW.committed_at IS NULL)
  OR (NEW.status = 'ABORTED' AND NEW.committed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'artifact_upload_intents immutable fields or terminal state changed'); END;

CREATE TABLE IF NOT EXISTS artifact_records (
  id TEXT PRIMARY KEY,
  artifact_schema TEXT NOT NULL DEFAULT 'sympose-artifact-record/v1',
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  task_id TEXT NOT NULL REFERENCES speaker_tasks(id),
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  supersedes_record_id TEXT REFERENCES artifact_records(id),
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_id TEXT NOT NULL UNIQUE,
  storage_filename TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  display_filename TEXT NOT NULL,
  created_at TEXT NOT NULL,
  content_version_id TEXT NOT NULL REFERENCES speaker_content_versions(id),
  authority_event_id TEXT NOT NULL REFERENCES domain_events(id),
  UNIQUE (workspace_id, event_id, person_id, task_id, kind, version),
  CHECK (artifact_schema = 'sympose-artifact-record/v1'),
  CHECK (length(CAST(id AS BLOB)) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  CHECK (kind IN ('HEADSHOT', 'SLIDES')),
  CHECK (version > 0),
  CHECK (storage_provider = 'local'),
  CHECK (length(CAST(storage_id AS BLOB)) = 64 AND storage_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (storage_filename = storage_id || '.bin'),
  CHECK (storage_filename NOT LIKE '%/%' AND storage_filename NOT LIKE '%\\%'),
  CHECK (length(CAST(sha256 AS BLOB)) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK ((kind = 'HEADSHOT' AND size_bytes BETWEEN 1 AND 8388608) OR (kind = 'SLIDES' AND size_bytes BETWEEN 1 AND 26214400)),
  CHECK ((kind = 'HEADSHOT' AND media_type = 'image/png') OR (kind = 'SLIDES' AND media_type = 'application/pdf')),
  CHECK ((kind = 'HEADSHOT' AND lower(display_filename) LIKE '%.png') OR (kind = 'SLIDES' AND lower(display_filename) LIKE '%.pdf')),
  CHECK (length(CAST(display_filename AS BLOB)) BETWEEN 1 AND 180),
  CHECK (display_filename NOT LIKE '%/%' AND display_filename NOT LIKE '%\\%'),
  CHECK (display_filename NOT GLOB '*[' || char(0) || '-' || char(31) || ']*'),
  CHECK (length(CAST(created_at AS BLOB)) BETWEEN 1 AND 128)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_artifact_records_scope
  ON artifact_records (workspace_id, event_id, person_id, task_id, kind, version);

CREATE TRIGGER IF NOT EXISTS trg_artifact_records_scope_guard
BEFORE INSERT ON artifact_records
WHEN NOT EXISTS (
  SELECT 1
  FROM speaker_tasks task
  WHERE task.id = NEW.task_id
    AND task.workspace_id = NEW.workspace_id
    AND task.event_id = NEW.event_id
    AND task.person_id = NEW.person_id
    AND task.content_kind = NEW.kind
)
  OR NOT EXISTS (
    SELECT 1 FROM events event_row
  JOIN people person_row ON person_row.workspace_id = event_row.workspace_id
  WHERE event_row.id = NEW.event_id
    AND event_row.workspace_id = NEW.workspace_id
    AND person_row.id = NEW.person_id
  )
OR NOT ${speakerTaskAuthorityExistsSql("NEW.task_id", "NEW.workspace_id", "NEW.event_id", "NEW.person_id", "NEW.kind")}
BEGIN SELECT RAISE(ABORT, 'artifact_records scope or task binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_artifact_records_authority_guard
BEFORE INSERT ON artifact_records
WHEN NOT EXISTS (
  SELECT 1
  FROM speaker_content_versions version
  WHERE version.id = NEW.content_version_id
    AND version.workspace_id = NEW.workspace_id
    AND version.event_id = NEW.event_id
    AND version.person_id = NEW.person_id
    AND version.task_id = NEW.task_id
    AND version.kind = NEW.kind
    AND version.version = NEW.version
    AND sympose_pd01_canonical_json(json_object(
      'asset', json_object(
        'assetId', json_extract(version.payload_json, '$.asset.assetId'),
        'byteSize', json_extract(version.payload_json, '$.asset.byteSize'),
        'checksum', json_extract(version.payload_json, '$.asset.checksum'),
        'fileName', json_extract(version.payload_json, '$.asset.fileName'),
        'mediaType', json_extract(version.payload_json, '$.asset.mediaType'),
        'storageRef', json_extract(version.payload_json, '$.asset.storageRef')),
      'kind', json_extract(version.payload_json, '$.kind'))) IS version.payload_json
    AND json_extract(version.payload_json, '$.kind') = NEW.kind
    AND json_extract(version.payload_json, '$.asset.assetId') = NEW.id
    AND json_extract(version.payload_json, '$.asset.fileName') = NEW.display_filename
    AND json_extract(version.payload_json, '$.asset.mediaType') = NEW.media_type
    AND json_extract(version.payload_json, '$.asset.byteSize') = NEW.size_bytes
    AND json_extract(version.payload_json, '$.asset.checksum') = NEW.sha256
    AND json_extract(version.payload_json, '$.asset.storageRef') = ('synthetic://artifact/' || NEW.id)
)
OR NOT EXISTS (
  SELECT 1
  FROM domain_events event_row
  WHERE event_row.id = NEW.authority_event_id
    AND event_row.workspace_id = NEW.workspace_id
    AND event_row.event_type = 'speaker.artifact.submitted'
    AND event_row.aggregate_type = 'speaker_task'
    AND event_row.aggregate_id = NEW.task_id
    AND json_extract(event_row.payload_json, '$.artifactId') = NEW.id
    AND json_extract(event_row.payload_json, '$.workspaceId') = NEW.workspace_id
    AND json_extract(event_row.payload_json, '$.eventId') = NEW.event_id
    AND json_extract(event_row.payload_json, '$.personId') = NEW.person_id
    AND json_extract(event_row.payload_json, '$.taskId') = NEW.task_id
    AND json_extract(event_row.payload_json, '$.kind') = NEW.kind
    AND json_extract(event_row.payload_json, '$.version') = NEW.version
    AND json_extract(event_row.payload_json, '$.storageId') = NEW.storage_id
    AND json_extract(event_row.payload_json, '$.storageFilename') = NEW.storage_filename
    AND json_extract(event_row.payload_json, '$.sha256') = NEW.sha256
    AND json_extract(event_row.payload_json, '$.byteSize') = NEW.size_bytes
    AND json_extract(event_row.payload_json, '$.mediaType') = NEW.media_type
    AND json_extract(event_row.payload_json, '$.displayFilename') = NEW.display_filename
    AND json_extract(event_row.payload_json, '$.contentVersionId') = NEW.content_version_id
      AND json_extract(event_row.payload_json, '$.contentVersionHash') = (
      SELECT version.content_hash FROM speaker_content_versions version WHERE version.id = NEW.content_version_id)
  )
OR NOT EXISTS (
  SELECT 1
  FROM artifact_upload_intents intent
  WHERE intent.artifact_id = NEW.id
    AND intent.workspace_id = NEW.workspace_id
    AND intent.event_id = NEW.event_id
    AND intent.person_id = NEW.person_id
    AND intent.task_id = NEW.task_id
    AND intent.kind = NEW.kind
    AND intent.storage_id = NEW.storage_id
    AND intent.storage_filename = NEW.storage_filename
    AND intent.content_version_id = NEW.content_version_id
    AND intent.status IN ('PREPARED', 'COMMITTED')
)
BEGIN SELECT RAISE(ABORT, 'artifact_records durable authority mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_artifact_records_lineage_guard
BEFORE INSERT ON artifact_records
WHEN (NEW.version = 1 AND NEW.supersedes_record_id IS NOT NULL)
  OR (NEW.version > 1 AND NOT EXISTS (
    SELECT 1
    FROM artifact_records prior
    WHERE prior.id = NEW.supersedes_record_id
      AND prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id
      AND prior.person_id = NEW.person_id
      AND prior.task_id = NEW.task_id
      AND prior.kind = NEW.kind
      AND prior.version = NEW.version - 1
  ))
BEGIN SELECT RAISE(ABORT, 'artifact_records lineage mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_artifact_records_immutable
BEFORE UPDATE ON artifact_records
BEGIN SELECT RAISE(ABORT, 'artifact_records are immutable evidence'); END;

CREATE TRIGGER IF NOT EXISTS trg_artifact_records_no_delete
BEFORE DELETE ON artifact_records
BEGIN SELECT RAISE(ABORT, 'artifact_records are retained'); END;

CREATE TABLE IF NOT EXISTS speaker_artifact_release_bindings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  release_id TEXT NOT NULL REFERENCES publication_releases(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  artifact_id TEXT NOT NULL REFERENCES artifact_records(id),
  content_hash TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  UNIQUE (workspace_id, release_id, person_id),
  UNIQUE (workspace_id, release_id, artifact_id),
  CHECK (length(CAST(content_hash AS BLOB)) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(CAST(bound_at AS BLOB)) BETWEEN 1 AND 128)
) STRICT;

CREATE TRIGGER IF NOT EXISTS trg_speaker_artifact_release_bindings_guard
BEFORE INSERT ON speaker_artifact_release_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM publication_releases release_row
  WHERE release_row.id = NEW.release_id
    AND release_row.workspace_id = NEW.workspace_id
    AND release_row.event_id = NEW.event_id
)
OR NOT EXISTS (
  SELECT 1 FROM artifact_records artifact
  WHERE artifact.id = NEW.artifact_id
    AND artifact.workspace_id = NEW.workspace_id
    AND artifact.event_id = NEW.event_id
    AND artifact.person_id = NEW.person_id
    AND artifact.kind = 'HEADSHOT'
)
OR NOT EXISTS (
  SELECT 1
  FROM speaker_content_reviews review
  JOIN speaker_content_versions version ON version.id = review.submission_version_id
  JOIN artifact_records artifact ON artifact.content_version_id = version.id
  WHERE artifact.id = NEW.artifact_id
    AND review.workspace_id = NEW.workspace_id
    AND review.event_id = NEW.event_id
    AND review.person_id = NEW.person_id
    AND review.submission_content_hash = NEW.content_hash
    AND version.content_hash = NEW.content_hash
    AND review.review_state = 'APPROVED'
    AND review.gate = 'PUBLICATION'
)
OR NOT EXISTS (
  SELECT 1
  FROM publication_releases release_row, json_each(release_row.content_json, '$.accepted') accepted
  WHERE release_row.id = NEW.release_id
    AND release_row.workspace_id = NEW.workspace_id
    AND release_row.event_id = NEW.event_id
    AND json_extract(release_row.content_json, '$.schema') = 'publication-release/v2'
    AND json_extract(accepted.value, '$.personId') = NEW.person_id
)
BEGIN SELECT RAISE(ABORT, 'speaker_artifact_release_bindings approval mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_artifact_release_bindings_immutable
BEFORE UPDATE ON speaker_artifact_release_bindings
BEGIN SELECT RAISE(ABORT, 'speaker_artifact_release_bindings are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_speaker_artifact_release_bindings_no_delete
BEFORE DELETE ON speaker_artifact_release_bindings
BEGIN SELECT RAISE(ABORT, 'speaker_artifact_release_bindings are retained'); END;
`;

/**
 * V15 gives each immutable review-round identity an append-only, independently versioned
 * schedule. The initial version is derived from the retained call window (or, only when both
 * legacy call bounds are absent, the owning event window). Organizer changes append versions; they
 * never update the round row or an earlier schedule version.
 */
export const V15_DDL = `
CREATE TABLE IF NOT EXISTS review_round_schedule_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  round_id TEXT NOT NULL REFERENCES review_rounds(id),
  version_number INTEGER NOT NULL
    CHECK (typeof(version_number) = 'integer' AND version_number >= 1),
  expected_previous_version INTEGER NOT NULL
    CHECK (typeof(expected_previous_version) = 'integer' AND expected_previous_version >= 0),
  timezone TEXT NOT NULL
    CHECK (typeof(timezone) = 'text'
      AND length(CAST(timezone AS BLOB)) BETWEEN 1 AND 128
      AND timezone NOT GLOB '*[^A-Za-z0-9_+./-]*'),
  opens_at TEXT NOT NULL
    CHECK ${v15CanonicalTimestampCheck("opens_at")},
  closes_at TEXT NOT NULL
    CHECK ${v15CanonicalTimestampCheck("closes_at")},
  source TEXT NOT NULL CHECK (source IN ('CALL_BACKFILL', 'ORGANIZER_INPUT')),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL
    CHECK (typeof(idempotency_key) = 'text' AND length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL
    CHECK ${v15CanonicalTimestampCheck("created_at")},
  UNIQUE (round_id, version_number),
  UNIQUE (round_id, idempotency_key),
  CHECK (version_number = expected_previous_version + 1),
  CHECK (opens_at < closes_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_review_round_schedule_versions_scope
  ON review_round_schedule_versions (workspace_id, event_id, round_id, version_number);

CREATE TABLE IF NOT EXISTS review_round_creation_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL
    CHECK (typeof(idempotency_key) = 'text' AND length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128),
  request_schema TEXT NOT NULL CHECK (request_schema = 'cfp-review-round-create-request/v1'),
  request_fingerprint TEXT NOT NULL
    CHECK (length(request_fingerprint) = 64 AND NOT (request_fingerprint GLOB '*[^0-9a-f]*')),
  round_id TEXT NOT NULL REFERENCES review_rounds(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  schedule_version INTEGER NOT NULL CHECK (typeof(schedule_version) = 'integer' AND schedule_version >= 1),
  timezone TEXT NOT NULL CHECK (
    length(CAST(timezone AS BLOB)) BETWEEN 1 AND 128
    AND timezone NOT GLOB '*[^A-Za-z0-9_+./-]*'
  ),
  opens_at TEXT NOT NULL CHECK (
    ${v15CanonicalTimestampCheck("opens_at")}
  ),
  closes_at TEXT NOT NULL CHECK (
    ${v15CanonicalTimestampCheck("closes_at")}
  ),
  created_at TEXT NOT NULL CHECK (
    ${v15CanonicalTimestampCheck("created_at")}
  ),
  UNIQUE (workspace_id, actor_account_id, idempotency_key),
  UNIQUE (round_id),
  CHECK (opens_at < closes_at)
) STRICT;

CREATE TRIGGER IF NOT EXISTS trg_review_round_schedule_versions_guard
BEFORE INSERT ON review_round_schedule_versions
WHEN NEW.timezone GLOB '*[^A-Za-z0-9_+./-]*'
  OR NOT ${v15CanonicalTimestampCheck("NEW.opens_at")}
  OR NOT ${v15CanonicalTimestampCheck("NEW.closes_at")}
  OR NOT ${v15CanonicalTimestampCheck("NEW.created_at")}
  OR NOT EXISTS (
    SELECT 1
    FROM review_rounds round
    JOIN events event_row
      ON event_row.id = round.event_id
     AND event_row.workspace_id = round.workspace_id
    JOIN accounts actor
      ON actor.id = NEW.actor_account_id
     AND actor.workspace_id = round.workspace_id
    WHERE round.id = NEW.round_id
      AND round.workspace_id = NEW.workspace_id
      AND round.event_id = NEW.event_id
      AND NEW.created_at >= round.created_at
  )
  OR NEW.expected_previous_version IS NOT COALESCE((
    SELECT MAX(prior.version_number)
    FROM review_round_schedule_versions prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id
      AND prior.round_id = NEW.round_id
  ), 0)
  OR EXISTS (
    SELECT 1
    FROM review_round_schedule_versions prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id
      AND prior.round_id = NEW.round_id
      AND prior.version_number = NEW.expected_previous_version
      AND NEW.created_at < prior.created_at
  )
  OR (NEW.version_number = 1 AND NEW.source != 'CALL_BACKFILL')
  OR (NEW.version_number > 1 AND NEW.source != 'ORGANIZER_INPUT')
  OR (NEW.version_number > 1 AND NOT EXISTS (
    SELECT 1 FROM review_round_schedule_versions prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id
      AND prior.round_id = NEW.round_id
      AND prior.version_number = NEW.expected_previous_version
      AND prior.timezone = NEW.timezone
  ))
BEGIN SELECT RAISE(ABORT, 'review_round_schedule_versions scope, chronology, or version mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_round_schedule_versions_immutable
BEFORE UPDATE ON review_round_schedule_versions
BEGIN SELECT RAISE(ABORT, 'review_round_schedule_versions is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_round_schedule_versions_no_delete
BEFORE DELETE ON review_round_schedule_versions
BEGIN SELECT RAISE(ABORT, 'review_round_schedule_versions is retained for history'); END;

INSERT INTO review_round_schedule_versions
  (id, workspace_id, event_id, round_id, version_number, expected_previous_version,
   timezone, opens_at, closes_at, source, actor_account_id, idempotency_key, created_at)
SELECT 'review-round-schedule:v1:' || round.id,
       round.workspace_id,
       round.event_id,
       round.id,
       1,
       0,
       CASE
         WHEN typeof(call.timezone) = 'text'
          AND length(CAST(call.timezone AS BLOB)) BETWEEN 1 AND 128
          AND call.timezone NOT GLOB '*[^A-Za-z0-9_+./-]*'
         THEN call.timezone
         ELSE NULL
       END,
       CASE
         WHEN call.opens_at IS NULL AND call.closes_at IS NULL
          AND ${v15StrictZonedTimestampCheck("event_row.starts_at")}
          AND ${v15StrictZonedTimestampCheck("event_row.ends_at")}
          AND strftime('%Y-%m-%dT%H:%M:%fZ', event_row.starts_at)
              < strftime('%Y-%m-%dT%H:%M:%fZ', event_row.ends_at)
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', event_row.starts_at)
         WHEN call.opens_at IS NOT NULL AND call.closes_at IS NOT NULL
          AND ${v15StrictZonedTimestampCheck("call.opens_at")}
          AND ${v15StrictZonedTimestampCheck("call.closes_at")}
          AND strftime('%Y-%m-%dT%H:%M:%fZ', call.opens_at)
              < strftime('%Y-%m-%dT%H:%M:%fZ', call.closes_at)
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', call.opens_at)
         ELSE NULL
       END,
       CASE
         WHEN call.opens_at IS NULL AND call.closes_at IS NULL
          AND ${v15StrictZonedTimestampCheck("event_row.starts_at")}
          AND ${v15StrictZonedTimestampCheck("event_row.ends_at")}
          AND strftime('%Y-%m-%dT%H:%M:%fZ', event_row.starts_at)
              < strftime('%Y-%m-%dT%H:%M:%fZ', event_row.ends_at)
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', event_row.ends_at)
         WHEN call.opens_at IS NOT NULL AND call.closes_at IS NOT NULL
          AND ${v15StrictZonedTimestampCheck("call.opens_at")}
          AND ${v15StrictZonedTimestampCheck("call.closes_at")}
          AND strftime('%Y-%m-%dT%H:%M:%fZ', call.opens_at)
              < strftime('%Y-%m-%dT%H:%M:%fZ', call.closes_at)
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', call.closes_at)
         ELSE NULL
       END,
       'CALL_BACKFILL',
       round.created_by,
       'review-round-schedule:v1:' || round.id,
       round.created_at
FROM review_rounds round
JOIN calls call
  ON call.id = round.call_id
 AND call.workspace_id = round.workspace_id
 AND call.event_id = round.event_id
JOIN events event_row
  ON event_row.id = round.event_id
 AND event_row.workspace_id = round.workspace_id
WHERE NOT EXISTS (
  SELECT 1 FROM review_round_schedule_versions existing
  WHERE existing.workspace_id = round.workspace_id
    AND existing.event_id = round.event_id
    AND existing.round_id = round.id
);

CREATE TRIGGER IF NOT EXISTS trg_review_rounds_initialize_schedule
AFTER INSERT ON review_rounds
BEGIN
  INSERT INTO review_round_schedule_versions
    (id, workspace_id, event_id, round_id, version_number, expected_previous_version,
     timezone, opens_at, closes_at, source, actor_account_id, idempotency_key, created_at)
  SELECT 'review-round-schedule:v1:' || NEW.id,
         NEW.workspace_id,
         NEW.event_id,
         NEW.id,
         1,
         0,
         CASE
           WHEN typeof(call.timezone) = 'text'
            AND length(CAST(call.timezone AS BLOB)) BETWEEN 1 AND 128
            AND call.timezone NOT GLOB '*[^A-Za-z0-9_+./-]*'
           THEN call.timezone
           ELSE NULL
         END,
         CASE
           WHEN call.opens_at IS NULL AND call.closes_at IS NULL
            AND ${v15StrictZonedTimestampCheck("event_row.starts_at")}
            AND ${v15StrictZonedTimestampCheck("event_row.ends_at")}
            AND strftime('%Y-%m-%dT%H:%M:%fZ', event_row.starts_at)
                < strftime('%Y-%m-%dT%H:%M:%fZ', event_row.ends_at)
           THEN strftime('%Y-%m-%dT%H:%M:%fZ', event_row.starts_at)
           WHEN call.opens_at IS NOT NULL AND call.closes_at IS NOT NULL
            AND ${v15StrictZonedTimestampCheck("call.opens_at")}
            AND ${v15StrictZonedTimestampCheck("call.closes_at")}
            AND strftime('%Y-%m-%dT%H:%M:%fZ', call.opens_at)
                < strftime('%Y-%m-%dT%H:%M:%fZ', call.closes_at)
           THEN strftime('%Y-%m-%dT%H:%M:%fZ', call.opens_at)
           ELSE NULL
         END,
         CASE
           WHEN call.opens_at IS NULL AND call.closes_at IS NULL
            AND ${v15StrictZonedTimestampCheck("event_row.starts_at")}
            AND ${v15StrictZonedTimestampCheck("event_row.ends_at")}
            AND strftime('%Y-%m-%dT%H:%M:%fZ', event_row.starts_at)
                < strftime('%Y-%m-%dT%H:%M:%fZ', event_row.ends_at)
           THEN strftime('%Y-%m-%dT%H:%M:%fZ', event_row.ends_at)
           WHEN call.opens_at IS NOT NULL AND call.closes_at IS NOT NULL
            AND ${v15StrictZonedTimestampCheck("call.opens_at")}
            AND ${v15StrictZonedTimestampCheck("call.closes_at")}
            AND strftime('%Y-%m-%dT%H:%M:%fZ', call.opens_at)
                < strftime('%Y-%m-%dT%H:%M:%fZ', call.closes_at)
           THEN strftime('%Y-%m-%dT%H:%M:%fZ', call.closes_at)
           ELSE NULL
         END,
         'CALL_BACKFILL',
         NEW.created_by,
         'review-round-schedule:v1:' || NEW.id,
         NEW.created_at
  FROM calls call
  JOIN events event_row
    ON event_row.id = NEW.event_id
   AND event_row.workspace_id = NEW.workspace_id
  WHERE call.id = NEW.call_id
    AND call.workspace_id = NEW.workspace_id
    AND call.event_id = NEW.event_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_review_round_creation_receipts_guard
BEFORE INSERT ON review_round_creation_receipts
WHEN NEW.timezone GLOB '*[^A-Za-z0-9_+./-]*'
  OR NOT ${v15CanonicalTimestampCheck("NEW.opens_at")}
  OR NOT ${v15CanonicalTimestampCheck("NEW.closes_at")}
  OR NOT ${v15CanonicalTimestampCheck("NEW.created_at")}
  OR NOT EXISTS (
    SELECT 1 FROM review_rounds round
    JOIN accounts actor ON actor.id = NEW.actor_account_id AND actor.workspace_id = round.workspace_id
    JOIN review_round_states state ON state.round_id = round.id AND state.workspace_id = round.workspace_id
      AND state.sequence_number = 1 AND state.state = 'DRAFT'
    JOIN review_round_schedule_versions schedule ON schedule.round_id = round.id
      AND schedule.workspace_id = round.workspace_id AND schedule.event_id = round.event_id
      AND schedule.version_number = NEW.schedule_version
    WHERE round.id = NEW.round_id AND round.workspace_id = NEW.workspace_id
      AND round.event_id = NEW.event_id AND round.call_id = NEW.call_id
      AND round.created_by = NEW.actor_account_id
      AND schedule.timezone = NEW.timezone AND schedule.opens_at = NEW.opens_at
      AND schedule.closes_at = NEW.closes_at
  )
BEGIN SELECT RAISE(ABORT, 'review_round_creation_receipts binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_round_creation_receipts_immutable
BEFORE UPDATE ON review_round_creation_receipts
BEGIN SELECT RAISE(ABORT, 'review_round_creation_receipts is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_review_round_creation_receipts_no_delete
BEFORE DELETE ON review_round_creation_receipts
BEGIN SELECT RAISE(ABORT, 'review_round_creation_receipts is retained for history'); END;
`;

/**
 * V16 gives the pinned reviewer journey its own durable authority boundary. Audit rows can
 * explain an action, but they cannot make a reviewer usable: the exact access-state history and
 * its immutable request receipt must bind the workspace, event, round, CFP assignment, event
 * reviewer assignment, account, Person, and account/Person binding together.
 */
export const V16_REVIEWER_ACCESS_REQUEST_SCHEMA = "cfp-reviewer-access-request/v1" as const;
export const V16_REVIEWER_ACCESS_RECEIPT_SCHEMA = "cfp-reviewer-access-receipt/v1" as const;

export const V16_DDL = `
CREATE TABLE IF NOT EXISTS reviewer_access_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  round_id TEXT NOT NULL REFERENCES review_rounds(id),
  assignment_id TEXT NOT NULL REFERENCES review_assignments(id),
  event_reviewer_assignment_id TEXT NOT NULL REFERENCES event_reviewer_assignments(id),
  reviewer_account_id TEXT NOT NULL REFERENCES accounts(id),
  reviewer_person_id TEXT NOT NULL REFERENCES people(id),
  account_person_binding_id TEXT NOT NULL REFERENCES account_person_bindings(id),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  intent TEXT NOT NULL CHECK (intent IN ('PROVISION', 'INVITE', 'ACTIVATE')),
  state TEXT NOT NULL CHECK (state IN ('PROVISIONED', 'INVITED', 'ACTIVE')),
  idempotency_key TEXT NOT NULL
    CHECK (typeof(idempotency_key) = 'text'
      AND length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128
      AND instr(idempotency_key, char(0)) = 0),
  request_schema TEXT NOT NULL CHECK (request_schema = 'cfp-reviewer-access-request/v1'),
  request_fingerprint TEXT NOT NULL
    CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  receipt_schema TEXT NOT NULL CHECK (receipt_schema = 'cfp-reviewer-access-receipt/v1'),
  transitioned INTEGER NOT NULL CHECK (typeof(transitioned) = 'integer' AND transitioned IN (0, 1)),
  effect_state_id TEXT,
  created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")},
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, request_fingerprint, idempotency_key),
  CHECK ((transitioned = 1 AND effect_state_id = 'reviewer-access-state:' || id)
    OR (transitioned = 0 AND effect_state_id IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS reviewer_access_states (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  round_id TEXT NOT NULL REFERENCES review_rounds(id),
  assignment_id TEXT NOT NULL REFERENCES review_assignments(id),
  event_reviewer_assignment_id TEXT NOT NULL REFERENCES event_reviewer_assignments(id),
  reviewer_account_id TEXT NOT NULL REFERENCES accounts(id),
  reviewer_person_id TEXT NOT NULL REFERENCES people(id),
  account_person_binding_id TEXT NOT NULL REFERENCES account_person_bindings(id),
  state TEXT NOT NULL CHECK (state IN ('PROVISIONED', 'INVITED', 'ACTIVE')),
  sequence_number INTEGER NOT NULL
    CHECK (typeof(sequence_number) = 'integer' AND sequence_number BETWEEN 1 AND 3),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  receipt_id TEXT NOT NULL REFERENCES reviewer_access_receipts(id),
  created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")},
  UNIQUE (workspace_id, assignment_id, sequence_number),
  UNIQUE (workspace_id, receipt_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_reviewer_access_states_scope
  ON reviewer_access_states (workspace_id, event_id, round_id, assignment_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_reviewer_access_receipts_scope
  ON reviewer_access_receipts (workspace_id, event_id, round_id, assignment_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_reviewer_access_receipts_guard
BEFORE INSERT ON reviewer_access_receipts
WHEN NEW.receipt_schema <> 'cfp-reviewer-access-receipt/v1'
  OR NEW.request_schema <> 'cfp-reviewer-access-request/v1'
  OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at) IS NOT NEW.created_at
  OR (NEW.intent = 'PROVISION' AND NEW.state <> 'PROVISIONED')
  OR (NEW.intent = 'INVITE' AND NEW.state <> 'INVITED')
  OR (NEW.intent = 'ACTIVATE' AND NEW.state <> 'ACTIVE')
  OR (NEW.transitioned = 1 AND NEW.effect_state_id <> 'reviewer-access-state:' || NEW.id)
  OR (NEW.transitioned = 0 AND NEW.effect_state_id IS NOT NULL)
  OR (NEW.transitioned = 0 AND NOT EXISTS (
    SELECT 1
    FROM reviewer_access_states existing_state
    WHERE existing_state.workspace_id = NEW.workspace_id
      AND existing_state.assignment_id = NEW.assignment_id
      AND existing_state.sequence_number = (
        SELECT MAX(candidate.sequence_number)
        FROM reviewer_access_states candidate
        WHERE candidate.workspace_id = NEW.workspace_id
          AND candidate.assignment_id = NEW.assignment_id
      )
      AND existing_state.sequence_number >= CASE NEW.intent
        WHEN 'PROVISION' THEN 1
        WHEN 'INVITE' THEN 2
        WHEN 'ACTIVATE' THEN 3
      END
  ))
  OR NOT EXISTS (
    SELECT 1
    FROM events event_row
    JOIN review_rounds round_row
      ON round_row.id = NEW.round_id
     AND round_row.workspace_id = NEW.workspace_id
     AND round_row.event_id = NEW.event_id
    JOIN review_assignments assignment
      ON assignment.id = NEW.assignment_id
     AND assignment.workspace_id = NEW.workspace_id
     AND assignment.round_id = NEW.round_id
     AND assignment.reviewer_account_id = NEW.reviewer_account_id
    JOIN submissions submission
      ON submission.id = assignment.submission_id
     AND submission.workspace_id = NEW.workspace_id
     AND submission.event_id = NEW.event_id
    JOIN event_reviewer_assignments event_assignment
      ON event_assignment.id = NEW.event_reviewer_assignment_id
     AND event_assignment.workspace_id = NEW.workspace_id
     AND event_assignment.event_id = NEW.event_id
     AND event_assignment.reviewer_account_id = NEW.reviewer_account_id
     AND event_assignment.reviewer_person_id = NEW.reviewer_person_id
     AND event_assignment.account_person_binding_id = NEW.account_person_binding_id
    JOIN account_person_bindings binding
      ON binding.id = NEW.account_person_binding_id
     AND binding.workspace_id = NEW.workspace_id
     AND binding.account_id = NEW.reviewer_account_id
     AND binding.person_id = NEW.reviewer_person_id
    JOIN people person
      ON person.id = NEW.reviewer_person_id
     AND person.workspace_id = NEW.workspace_id
    JOIN accounts reviewer
      ON reviewer.id = NEW.reviewer_account_id
     AND reviewer.workspace_id = NEW.workspace_id
     AND reviewer.role = 'reviewer'
    JOIN accounts actor
      ON actor.id = NEW.actor_account_id
     AND actor.workspace_id = NEW.workspace_id
     AND actor.role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
    WHERE event_row.id = NEW.event_id
      AND event_row.workspace_id = NEW.workspace_id
      AND EXISTS (
        SELECT 1
        FROM review_round_states round_state
        WHERE round_state.workspace_id = NEW.workspace_id
          AND round_state.round_id = NEW.round_id
          AND round_state.sequence_number = (
            SELECT MAX(candidate.sequence_number)
            FROM review_round_states candidate
            WHERE candidate.workspace_id = NEW.workspace_id
              AND candidate.round_id = NEW.round_id
          )
          AND round_state.state IN ('DRAFT', 'OPEN')
      )
      AND EXISTS (
        SELECT 1
        FROM review_assignment_states assignment_state
        WHERE assignment_state.workspace_id = NEW.workspace_id
          AND assignment_state.assignment_id = NEW.assignment_id
          AND assignment_state.sequence_number = (
            SELECT MAX(candidate.sequence_number)
            FROM review_assignment_states candidate
            WHERE candidate.workspace_id = NEW.workspace_id
              AND candidate.assignment_id = NEW.assignment_id
          )
          AND assignment_state.state IN ('ASSIGNED', 'IN_PROGRESS', 'SUBMITTED')
      )
      AND EXISTS (
        SELECT 1
        FROM event_reviewer_assignment_states event_assignment_state
        WHERE event_assignment_state.workspace_id = NEW.workspace_id
          AND event_assignment_state.event_reviewer_assignment_id = NEW.event_reviewer_assignment_id
          AND event_assignment_state.sequence_number = (
            SELECT MAX(candidate.sequence_number)
            FROM event_reviewer_assignment_states candidate
            WHERE candidate.workspace_id = NEW.workspace_id
              AND candidate.event_reviewer_assignment_id = NEW.event_reviewer_assignment_id
          )
          AND event_assignment_state.state = 'ACTIVE'
      )
  )
  OR sympose_pd01_fingerprint(json_object(
    'schema', NEW.request_schema,
    'actorAccountId', NEW.actor_account_id,
    'workspaceId', NEW.workspace_id,
    'eventId', NEW.event_id,
    'roundId', NEW.round_id,
    'assignmentId', NEW.assignment_id,
    'eventReviewerAssignmentId', NEW.event_reviewer_assignment_id,
    'reviewerAccountId', NEW.reviewer_account_id,
    'reviewerPersonId', NEW.reviewer_person_id,
    'accountPersonBindingId', NEW.account_person_binding_id,
    'intent', NEW.intent
  )) IS NOT NEW.request_fingerprint
BEGIN SELECT RAISE(ABORT, 'reviewer_access_receipts binding or fingerprint mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_reviewer_access_receipts_immutable
BEFORE UPDATE ON reviewer_access_receipts
BEGIN SELECT RAISE(ABORT, 'reviewer_access_receipts is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_reviewer_access_receipts_no_delete
BEFORE DELETE ON reviewer_access_receipts
BEGIN SELECT RAISE(ABORT, 'reviewer_access_receipts is retained for history'); END;

CREATE TRIGGER IF NOT EXISTS trg_reviewer_access_states_guard
BEFORE INSERT ON reviewer_access_states
WHEN NEW.id <> 'reviewer-access-state:' || NEW.receipt_id
  OR NEW.sequence_number IS NOT COALESCE((
    SELECT MAX(prior.sequence_number) + 1
    FROM reviewer_access_states prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.assignment_id = NEW.assignment_id
  ), 1)
  OR (NEW.sequence_number = 1 AND NEW.state <> 'PROVISIONED')
  OR (NEW.sequence_number = 2 AND NEW.state <> 'INVITED')
  OR (NEW.sequence_number = 3 AND NEW.state <> 'ACTIVE')
  OR (NEW.sequence_number > 1 AND NOT EXISTS (
    SELECT 1
    FROM reviewer_access_states prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.assignment_id = NEW.assignment_id
      AND prior.sequence_number = NEW.sequence_number - 1
      AND ((prior.state = 'PROVISIONED' AND NEW.state = 'INVITED')
        OR (prior.state = 'INVITED' AND NEW.state = 'ACTIVE'))
  ))
  OR NOT EXISTS (
    SELECT 1
    FROM reviewer_access_receipts receipt
    WHERE receipt.id = NEW.receipt_id
      AND receipt.workspace_id = NEW.workspace_id
      AND receipt.event_id = NEW.event_id
      AND receipt.round_id = NEW.round_id
      AND receipt.assignment_id = NEW.assignment_id
      AND receipt.event_reviewer_assignment_id = NEW.event_reviewer_assignment_id
      AND receipt.reviewer_account_id = NEW.reviewer_account_id
      AND receipt.reviewer_person_id = NEW.reviewer_person_id
      AND receipt.account_person_binding_id = NEW.account_person_binding_id
      AND receipt.actor_account_id = NEW.actor_account_id
      AND receipt.state = NEW.state
      AND receipt.transitioned = 1
      AND receipt.effect_state_id = NEW.id
      AND receipt.created_at = NEW.created_at
  )
  OR NOT EXISTS (
    SELECT 1
    FROM event_reviewer_assignments event_assignment
    JOIN account_person_bindings binding
      ON binding.id = event_assignment.account_person_binding_id
     AND binding.workspace_id = event_assignment.workspace_id
     AND binding.account_id = event_assignment.reviewer_account_id
     AND binding.person_id = event_assignment.reviewer_person_id
    JOIN review_assignments assignment
      ON assignment.id = NEW.assignment_id
     AND assignment.workspace_id = NEW.workspace_id
     AND assignment.round_id = NEW.round_id
     AND assignment.reviewer_account_id = NEW.reviewer_account_id
    JOIN review_rounds round_row
      ON round_row.id = NEW.round_id
     AND round_row.workspace_id = NEW.workspace_id
     AND round_row.event_id = NEW.event_id
    JOIN events event_row
      ON event_row.id = NEW.event_id
     AND event_row.workspace_id = NEW.workspace_id
    JOIN accounts reviewer
      ON reviewer.id = NEW.reviewer_account_id
     AND reviewer.workspace_id = NEW.workspace_id
     AND reviewer.role = 'reviewer'
    JOIN people person
      ON person.id = NEW.reviewer_person_id
     AND person.workspace_id = NEW.workspace_id
    JOIN accounts actor
      ON actor.id = NEW.actor_account_id
     AND actor.workspace_id = NEW.workspace_id
     AND actor.role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
    WHERE event_assignment.id = NEW.event_reviewer_assignment_id
      AND event_assignment.workspace_id = NEW.workspace_id
      AND event_assignment.event_id = NEW.event_id
      AND event_assignment.reviewer_account_id = NEW.reviewer_account_id
      AND event_assignment.reviewer_person_id = NEW.reviewer_person_id
      AND event_assignment.account_person_binding_id = NEW.account_person_binding_id
      AND EXISTS (
        SELECT 1
        FROM event_reviewer_assignment_states event_assignment_state
        WHERE event_assignment_state.workspace_id = NEW.workspace_id
          AND event_assignment_state.event_reviewer_assignment_id = NEW.event_reviewer_assignment_id
          AND event_assignment_state.sequence_number = (
            SELECT MAX(candidate.sequence_number)
            FROM event_reviewer_assignment_states candidate
            WHERE candidate.workspace_id = NEW.workspace_id
              AND candidate.event_reviewer_assignment_id = NEW.event_reviewer_assignment_id
          )
          AND event_assignment_state.state = 'ACTIVE'
      )
  )
BEGIN SELECT RAISE(ABORT, 'reviewer_access_states binding, sequence, or transition mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_reviewer_access_states_immutable
BEFORE UPDATE ON reviewer_access_states
BEGIN SELECT RAISE(ABORT, 'reviewer_access_states is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_reviewer_access_states_no_delete
BEFORE DELETE ON reviewer_access_states
BEGIN SELECT RAISE(ABORT, 'reviewer_access_states is retained for history'); END;
`;

/**
 * V17 adds an append-only publication-audience control plane beside the established public
 * release pointer. These records can describe and authorize exact audience projections, but no
 * trigger or foreign key from the existing release/pointer path depends on them.
 */
export const V17_PUBLICATION_AUDIENCE_POLICY_SCHEMA =
  "publication-audience-policy/v1" as const;
export const V17_PUBLICATION_AUDIENCE_REQUEST_SCHEMA =
  "publication-audience-command/v1" as const;
export const V17_PUBLICATION_AUDIENCE_RECEIPT_SCHEMA =
  "publication-audience-receipt/v1" as const;

export const V17_DDL = `
CREATE TABLE IF NOT EXISTS publication_release_versions (
  id TEXT PRIMARY KEY
    CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) BETWEEN 1 AND 320
      AND instr(id, char(0)) = 0),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  release_id TEXT NOT NULL REFERENCES publication_releases(id),
  version_number INTEGER NOT NULL
    CHECK (typeof(version_number) = 'integer' AND version_number BETWEEN 1 AND 9007199254740991),
  release_fingerprint TEXT NOT NULL
    CHECK (length(release_fingerprint) = 64 AND release_fingerprint NOT GLOB '*[^0-9a-f]*'),
  sealed_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("sealed_at")},
  catalog_source TEXT NOT NULL CHECK (catalog_source IN ('MIGRATION', 'COMMAND')),
  cataloged_by_account_id TEXT REFERENCES accounts(id),
  cataloged_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("cataloged_at")},
  catalog_fingerprint TEXT NOT NULL
    CHECK (length(catalog_fingerprint) = 64 AND catalog_fingerprint NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (workspace_id, event_id, release_id),
  UNIQUE (workspace_id, event_id, version_number)
) STRICT;

CREATE TABLE IF NOT EXISTS publication_audience_channels (
  id TEXT PRIMARY KEY
    CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) BETWEEN 1 AND 160
      AND instr(id, char(0)) = 0),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  channel_key TEXT NOT NULL
    CHECK (typeof(channel_key) = 'text' AND length(CAST(channel_key AS BLOB)) BETWEEN 1 AND 80
      AND channel_key NOT GLOB '*[^a-z0-9._-]*'),
  label TEXT NOT NULL
    CHECK (typeof(label) = 'text' AND length(CAST(label AS BLOB)) BETWEEN 1 AND 120
      AND trim(label) = label AND instr(label, char(0)) = 0),
  purpose TEXT NOT NULL
    CHECK (purpose IN ('EVENT_AGENDA', 'PERSONAL_AGENDA', 'SPEAKER_PORTAL', 'EMBED')),
  audience TEXT NOT NULL
    CHECK (audience IN ('PUBLIC', 'ATTENDEE', 'SPEAKER', 'ORGANIZER')),
  visibility TEXT NOT NULL
    CHECK (visibility IN ('PUBLIC', 'TOKEN', 'AUTHENTICATED')),
  initial_state TEXT NOT NULL CHECK (initial_state = 'ACTIVE'),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")},
  channel_fingerprint TEXT NOT NULL
    CHECK (length(channel_fingerprint) = 64 AND channel_fingerprint NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (workspace_id, event_id, id),
  UNIQUE (workspace_id, event_id, channel_key)
) STRICT;

CREATE TABLE IF NOT EXISTS publication_audience_policy_versions (
  id TEXT PRIMARY KEY
    CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) BETWEEN 1 AND 160
      AND instr(id, char(0)) = 0),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  channel_id TEXT NOT NULL REFERENCES publication_audience_channels(id),
  version_number INTEGER NOT NULL
    CHECK (typeof(version_number) = 'integer' AND version_number BETWEEN 1 AND 9007199254740991),
  purpose TEXT NOT NULL
    CHECK (purpose IN ('EVENT_AGENDA', 'PERSONAL_AGENDA', 'SPEAKER_PORTAL', 'EMBED')),
  audience TEXT NOT NULL
    CHECK (audience IN ('PUBLIC', 'ATTENDEE', 'SPEAKER', 'ORGANIZER')),
  visibility TEXT NOT NULL
    CHECK (visibility IN ('PUBLIC', 'TOKEN', 'AUTHENTICATED')),
  state TEXT NOT NULL CHECK (state = 'DRAFT'),
  rule TEXT NOT NULL
    CHECK (rule IN ('PUBLIC_SCHEDULE', 'ACCEPTED_AGENDAS', 'SPEAKER_PORTAL')),
  policy_schema TEXT NOT NULL CHECK (policy_schema = 'publication-audience-policy/v1'),
  policy_json TEXT NOT NULL
    CHECK (typeof(policy_json) = 'text' AND json_valid(policy_json) = 1
      AND length(CAST(policy_json AS BLOB)) BETWEEN 2 AND 65536),
  policy_fingerprint TEXT NOT NULL
    CHECK (length(policy_fingerprint) = 64 AND policy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")},
  UNIQUE (workspace_id, event_id, channel_id, version_number),
  UNIQUE (workspace_id, event_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS publication_audience_receipts (
  id TEXT PRIMARY KEY
    CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) BETWEEN 1 AND 160
      AND instr(id, char(0)) = 0),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  channel_id TEXT NOT NULL REFERENCES publication_audience_channels(id),
  sequence_number INTEGER NOT NULL
    CHECK (typeof(sequence_number) = 'integer' AND sequence_number BETWEEN 1 AND 9007199254740991),
  action TEXT NOT NULL
    CHECK (action IN ('CHANNEL_CREATED', 'CHANNEL_DISABLED', 'POLICY_DRAFTED',
      'POLICY_SUPERSEDED', 'RELEASE_BOUND', 'BINDING_DISABLED')),
  result_state TEXT NOT NULL
    CHECK (result_state IN ('ACTIVE', 'DISABLED', 'DRAFT', 'SUPERSEDED', 'BOUND', 'BLOCKED')),
  policy_version_id TEXT REFERENCES publication_audience_policy_versions(id),
  successor_policy_version_id TEXT REFERENCES publication_audience_policy_versions(id),
  release_version_id TEXT REFERENCES publication_release_versions(id),
  expected_release_id TEXT,
  expected_release_version INTEGER
    CHECK (expected_release_version IS NULL OR
      (typeof(expected_release_version) = 'integer'
        AND expected_release_version BETWEEN 1 AND 9007199254740991)),
  expected_release_fingerprint TEXT
    CHECK (expected_release_fingerprint IS NULL OR
      (length(expected_release_fingerprint) = 64
        AND expected_release_fingerprint NOT GLOB '*[^0-9a-f]*')),
  target_receipt_id TEXT REFERENCES publication_audience_receipts(id),
  predecessor_receipt_id TEXT REFERENCES publication_audience_receipts(id),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL
    CHECK (typeof(idempotency_key) = 'text'
      AND length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128
      AND instr(idempotency_key, char(0)) = 0),
  command_fingerprint TEXT NOT NULL
    CHECK (length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'),
  request_schema TEXT NOT NULL CHECK (request_schema = 'publication-audience-command/v1'),
  request_fingerprint TEXT NOT NULL
    CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  receipt_schema TEXT NOT NULL CHECK (receipt_schema = 'publication-audience-receipt/v1'),
  created_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("created_at")},
  UNIQUE (workspace_id, actor_account_id, idempotency_key),
  UNIQUE (workspace_id, event_id, channel_id, sequence_number)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_publication_release_versions_scope
  ON publication_release_versions (workspace_id, event_id, version_number, release_id);
CREATE INDEX IF NOT EXISTS idx_publication_audience_channels_scope
  ON publication_audience_channels
    (workspace_id, event_id, purpose, audience, visibility, channel_key, id);
CREATE INDEX IF NOT EXISTS idx_publication_audience_policies_scope
  ON publication_audience_policy_versions
    (workspace_id, event_id, channel_id, version_number, id);
CREATE INDEX IF NOT EXISTS idx_publication_audience_receipts_scope
  ON publication_audience_receipts
    (workspace_id, event_id, channel_id, sequence_number, id);
CREATE INDEX IF NOT EXISTS idx_publication_audience_receipts_release
  ON publication_audience_receipts
    (workspace_id, event_id, release_version_id, channel_id, sequence_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_publication_audience_binding_exact
  ON publication_audience_receipts
    (workspace_id, event_id, channel_id, policy_version_id, release_version_id)
  WHERE action = 'RELEASE_BOUND';
CREATE UNIQUE INDEX IF NOT EXISTS uq_publication_audience_policy_supersession
  ON publication_audience_receipts (workspace_id, event_id, policy_version_id)
  WHERE action = 'POLICY_SUPERSEDED';
CREATE UNIQUE INDEX IF NOT EXISTS uq_publication_audience_binding_disable
  ON publication_audience_receipts (workspace_id, event_id, target_receipt_id)
  WHERE action = 'BINDING_DISABLED';

CREATE TRIGGER IF NOT EXISTS trg_publication_release_versions_guard
BEFORE INSERT ON publication_release_versions
WHEN NEW.id <> 'publication-release-version:' || NEW.release_id
  OR NOT EXISTS (
    SELECT 1 FROM publication_releases release_row
    WHERE release_row.id = NEW.release_id
      AND release_row.workspace_id = NEW.workspace_id
      AND release_row.event_id = NEW.event_id
      AND release_row.fingerprint = NEW.release_fingerprint
      AND release_row.sealed_at = NEW.sealed_at
  )
  OR NEW.version_number IS NOT COALESCE((
    SELECT MAX(prior.version_number) + 1
    FROM publication_release_versions prior
    WHERE prior.workspace_id = NEW.workspace_id AND prior.event_id = NEW.event_id
  ), 1)
  OR ((NEW.catalog_source = 'MIGRATION') <> (NEW.cataloged_by_account_id IS NULL))
  OR (NEW.cataloged_by_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM accounts actor
    WHERE actor.id = NEW.cataloged_by_account_id
      AND actor.workspace_id = NEW.workspace_id
      AND actor.role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
  ))
  OR sympose_pd01_fingerprint(json_object(
    'schema', 'publication-release-version/v1',
    'workspaceId', NEW.workspace_id,
    'eventId', NEW.event_id,
    'releaseId', NEW.release_id,
    'versionNumber', NEW.version_number,
    'releaseFingerprint', NEW.release_fingerprint,
    'sealedAt', NEW.sealed_at,
    'catalogSource', NEW.catalog_source,
    'catalogedByAccountId', NEW.cataloged_by_account_id,
    'catalogedAt', NEW.cataloged_at
  )) IS NOT NEW.catalog_fingerprint
BEGIN SELECT RAISE(ABORT, 'publication_release_versions binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_publication_release_versions_immutable
BEFORE UPDATE ON publication_release_versions
BEGIN SELECT RAISE(ABORT, 'publication_release_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_publication_release_versions_no_delete
BEFORE DELETE ON publication_release_versions
BEGIN SELECT RAISE(ABORT, 'publication_release_versions is retained for history'); END;

CREATE TRIGGER IF NOT EXISTS trg_publication_audience_channels_guard
BEFORE INSERT ON publication_audience_channels
WHEN NOT EXISTS (
    SELECT 1 FROM events event_row
    WHERE event_row.id = NEW.event_id AND event_row.workspace_id = NEW.workspace_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM accounts actor
    WHERE actor.id = NEW.created_by_account_id
      AND actor.workspace_id = NEW.workspace_id
      AND actor.role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
  )
  OR sympose_pd01_fingerprint(json_object(
    'schema', 'publication-audience-channel/v1',
    'workspaceId', NEW.workspace_id,
    'eventId', NEW.event_id,
    'channelKey', NEW.channel_key,
    'label', NEW.label,
    'purpose', NEW.purpose,
    'audience', NEW.audience,
    'visibility', NEW.visibility,
    'initialState', NEW.initial_state,
    'createdByAccountId', NEW.created_by_account_id,
    'createdAt', NEW.created_at
  )) IS NOT NEW.channel_fingerprint
BEGIN SELECT RAISE(ABORT, 'publication_audience_channels binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_publication_audience_channels_immutable
BEFORE UPDATE ON publication_audience_channels
BEGIN SELECT RAISE(ABORT, 'publication_audience_channels is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_publication_audience_channels_no_delete
BEFORE DELETE ON publication_audience_channels
BEGIN SELECT RAISE(ABORT, 'publication_audience_channels is retained for history'); END;

CREATE TRIGGER IF NOT EXISTS trg_publication_audience_policies_guard
BEFORE INSERT ON publication_audience_policy_versions
WHEN NOT EXISTS (
    SELECT 1 FROM publication_audience_channels channel
    WHERE channel.id = NEW.channel_id
      AND channel.workspace_id = NEW.workspace_id
      AND channel.event_id = NEW.event_id
      AND channel.purpose = NEW.purpose
      AND channel.audience = NEW.audience
      AND channel.visibility = NEW.visibility
  )
  OR NOT EXISTS (
    SELECT 1 FROM accounts actor
    WHERE actor.id = NEW.created_by_account_id
      AND actor.workspace_id = NEW.workspace_id
      AND actor.role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
  )
  OR NEW.version_number IS NOT COALESCE((
    SELECT MAX(prior.version_number) + 1
    FROM publication_audience_policy_versions prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id
      AND prior.channel_id = NEW.channel_id
  ), 1)
  OR sympose_pd01_canonical_json(NEW.policy_json) IS NOT NEW.policy_json
  OR sympose_pd01_fingerprint(json_object(
    'schema', NEW.policy_schema,
    'workspaceId', NEW.workspace_id,
    'eventId', NEW.event_id,
    'channelId', NEW.channel_id,
    'versionNumber', NEW.version_number,
    'purpose', NEW.purpose,
    'audience', NEW.audience,
    'visibility', NEW.visibility,
    'state', NEW.state,
    'rule', NEW.rule,
    'policy', json(NEW.policy_json),
    'createdByAccountId', NEW.created_by_account_id,
    'createdAt', NEW.created_at
  )) IS NOT NEW.policy_fingerprint
BEGIN SELECT RAISE(ABORT, 'publication_audience_policy_versions binding mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_publication_audience_policies_immutable
BEFORE UPDATE ON publication_audience_policy_versions
BEGIN SELECT RAISE(ABORT, 'publication_audience_policy_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_publication_audience_policies_no_delete
BEFORE DELETE ON publication_audience_policy_versions
BEGIN SELECT RAISE(ABORT, 'publication_audience_policy_versions is retained for history'); END;

CREATE TRIGGER IF NOT EXISTS trg_publication_audience_receipts_guard
BEFORE INSERT ON publication_audience_receipts
WHEN NOT EXISTS (
    SELECT 1 FROM publication_audience_channels channel
    WHERE channel.id = NEW.channel_id
      AND channel.workspace_id = NEW.workspace_id
      AND channel.event_id = NEW.event_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM accounts actor
    WHERE actor.id = NEW.actor_account_id
      AND actor.workspace_id = NEW.workspace_id
      AND actor.role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
  )
  OR NEW.sequence_number IS NOT COALESCE((
    SELECT MAX(prior.sequence_number) + 1
    FROM publication_audience_receipts prior
    WHERE prior.workspace_id = NEW.workspace_id
      AND prior.event_id = NEW.event_id
      AND prior.channel_id = NEW.channel_id
  ), 1)
  OR (NEW.sequence_number = 1 AND NEW.predecessor_receipt_id IS NOT NULL)
  OR (NEW.sequence_number > 1 AND NOT EXISTS (
    SELECT 1 FROM publication_audience_receipts predecessor
    WHERE predecessor.id = NEW.predecessor_receipt_id
      AND predecessor.workspace_id = NEW.workspace_id
      AND predecessor.event_id = NEW.event_id
      AND predecessor.channel_id = NEW.channel_id
      AND predecessor.sequence_number = NEW.sequence_number - 1
  ))
  OR sympose_pd01_fingerprint(json_object(
    'schema', NEW.request_schema,
    'workspaceId', NEW.workspace_id,
    'eventId', NEW.event_id,
    'channelId', NEW.channel_id,
    'action', NEW.action,
    'policyVersionId', NEW.policy_version_id,
    'successorPolicyVersionId', NEW.successor_policy_version_id,
    'releaseVersionId', NEW.release_version_id,
    'expectedReleaseId', NEW.expected_release_id,
    'expectedReleaseVersion', NEW.expected_release_version,
    'expectedReleaseFingerprint', NEW.expected_release_fingerprint,
    'targetReceiptId', NEW.target_receipt_id,
    'actorAccountId', NEW.actor_account_id,
    'idempotencyKey', NEW.idempotency_key,
    'commandFingerprint', NEW.command_fingerprint
  )) IS NOT NEW.request_fingerprint
  OR (NEW.action = 'CHANNEL_CREATED' AND NOT (
    NEW.sequence_number = 1 AND NEW.result_state = 'ACTIVE'
    AND NEW.policy_version_id IS NULL AND NEW.successor_policy_version_id IS NULL
    AND NEW.release_version_id IS NULL AND NEW.expected_release_id IS NULL
    AND NEW.expected_release_version IS NULL AND NEW.expected_release_fingerprint IS NULL
    AND NEW.target_receipt_id IS NULL
    AND EXISTS (
      SELECT 1 FROM publication_audience_channels channel
      WHERE channel.id = NEW.channel_id
        AND channel.workspace_id = NEW.workspace_id
        AND channel.event_id = NEW.event_id
        AND channel.created_by_account_id = NEW.actor_account_id
        AND channel.created_at = NEW.created_at
    )
  ))
  OR (NEW.action = 'CHANNEL_DISABLED' AND NOT (
    NEW.result_state = 'DISABLED'
    AND NEW.policy_version_id IS NULL AND NEW.successor_policy_version_id IS NULL
    AND NEW.release_version_id IS NULL AND NEW.expected_release_id IS NULL
    AND NEW.expected_release_version IS NULL AND NEW.expected_release_fingerprint IS NULL
    AND NEW.target_receipt_id IS NULL
    AND EXISTS (
      SELECT 1 FROM publication_audience_receipts created
      WHERE created.workspace_id = NEW.workspace_id
        AND created.event_id = NEW.event_id
        AND created.channel_id = NEW.channel_id
        AND created.action = 'CHANNEL_CREATED'
    )
    AND NOT EXISTS (
      SELECT 1 FROM publication_audience_receipts disabled
      WHERE disabled.workspace_id = NEW.workspace_id
        AND disabled.event_id = NEW.event_id
        AND disabled.channel_id = NEW.channel_id
        AND disabled.action = 'CHANNEL_DISABLED'
    )
  ))
  OR (NEW.action = 'POLICY_DRAFTED' AND NOT (
    NEW.result_state = 'DRAFT' AND NEW.policy_version_id IS NOT NULL
    AND NEW.successor_policy_version_id IS NULL AND NEW.release_version_id IS NULL
    AND NEW.expected_release_id IS NULL AND NEW.expected_release_version IS NULL
    AND NEW.expected_release_fingerprint IS NULL AND NEW.target_receipt_id IS NULL
    AND EXISTS (
      SELECT 1 FROM publication_audience_policy_versions policy
      WHERE policy.id = NEW.policy_version_id
        AND policy.workspace_id = NEW.workspace_id
        AND policy.event_id = NEW.event_id
        AND policy.channel_id = NEW.channel_id
        AND policy.created_by_account_id = NEW.actor_account_id
        AND policy.created_at = NEW.created_at
    )
    AND EXISTS (
      SELECT 1 FROM publication_audience_receipts created
      WHERE created.workspace_id = NEW.workspace_id
        AND created.event_id = NEW.event_id
        AND created.channel_id = NEW.channel_id
        AND created.action = 'CHANNEL_CREATED'
    )
    AND NOT EXISTS (
      SELECT 1 FROM publication_audience_receipts disabled
      WHERE disabled.workspace_id = NEW.workspace_id
        AND disabled.event_id = NEW.event_id
        AND disabled.channel_id = NEW.channel_id
        AND disabled.action = 'CHANNEL_DISABLED'
    )
  ))
  OR (NEW.action = 'POLICY_SUPERSEDED' AND NOT (
    NEW.result_state = 'SUPERSEDED' AND NEW.policy_version_id IS NOT NULL
    AND NEW.successor_policy_version_id IS NOT NULL AND NEW.release_version_id IS NULL
    AND NEW.expected_release_id IS NULL AND NEW.expected_release_version IS NULL
    AND NEW.expected_release_fingerprint IS NULL AND NEW.target_receipt_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM publication_audience_policy_versions prior
      JOIN publication_audience_policy_versions successor
        ON successor.id = NEW.successor_policy_version_id
       AND successor.workspace_id = prior.workspace_id
       AND successor.event_id = prior.event_id
       AND successor.channel_id = prior.channel_id
       AND successor.version_number > prior.version_number
      WHERE prior.id = NEW.policy_version_id
        AND prior.workspace_id = NEW.workspace_id
        AND prior.event_id = NEW.event_id
        AND prior.channel_id = NEW.channel_id
    )
    AND EXISTS (
      SELECT 1 FROM publication_audience_receipts drafted
      WHERE drafted.workspace_id = NEW.workspace_id
        AND drafted.event_id = NEW.event_id
        AND drafted.channel_id = NEW.channel_id
        AND drafted.action = 'POLICY_DRAFTED'
        AND drafted.policy_version_id = NEW.policy_version_id
    )
    AND EXISTS (
      SELECT 1 FROM publication_audience_receipts drafted
      WHERE drafted.workspace_id = NEW.workspace_id
        AND drafted.event_id = NEW.event_id
        AND drafted.channel_id = NEW.channel_id
        AND drafted.action = 'POLICY_DRAFTED'
        AND drafted.policy_version_id = NEW.successor_policy_version_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM publication_audience_receipts superseded
      WHERE superseded.workspace_id = NEW.workspace_id
        AND superseded.event_id = NEW.event_id
        AND superseded.policy_version_id = NEW.policy_version_id
        AND superseded.action = 'POLICY_SUPERSEDED'
    )
    AND NOT EXISTS (
      SELECT 1 FROM publication_audience_receipts disabled
      WHERE disabled.workspace_id = NEW.workspace_id
        AND disabled.event_id = NEW.event_id
        AND disabled.channel_id = NEW.channel_id
        AND disabled.action = 'CHANNEL_DISABLED'
    )
  ))
  OR (NEW.action = 'RELEASE_BOUND' AND NOT (
    NEW.result_state = 'BOUND' AND NEW.policy_version_id IS NOT NULL
    AND NEW.successor_policy_version_id IS NULL AND NEW.release_version_id IS NOT NULL
    AND NEW.expected_release_id IS NOT NULL AND NEW.expected_release_version IS NOT NULL
    AND NEW.expected_release_fingerprint IS NOT NULL AND NEW.target_receipt_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM publication_audience_policy_versions policy
      JOIN publication_release_versions release_version
        ON release_version.id = NEW.release_version_id
       AND release_version.workspace_id = policy.workspace_id
       AND release_version.event_id = policy.event_id
      JOIN events event_row
        ON event_row.id = policy.event_id AND event_row.workspace_id = policy.workspace_id
      JOIN publication_releases release_row
        ON release_row.id = release_version.release_id
       AND release_row.workspace_id = release_version.workspace_id
       AND release_row.event_id = release_version.event_id
      WHERE policy.id = NEW.policy_version_id
        AND policy.workspace_id = NEW.workspace_id
        AND policy.event_id = NEW.event_id
        AND policy.channel_id = NEW.channel_id
        AND release_version.release_id = NEW.expected_release_id
        AND release_version.version_number = NEW.expected_release_version
        AND release_version.release_fingerprint = NEW.expected_release_fingerprint
        AND release_row.fingerprint = NEW.expected_release_fingerprint
        AND event_row.current_release_id = NEW.expected_release_id
    )
    AND EXISTS (
      SELECT 1 FROM publication_audience_receipts created
      WHERE created.workspace_id = NEW.workspace_id
        AND created.event_id = NEW.event_id
        AND created.channel_id = NEW.channel_id
        AND created.action = 'CHANNEL_CREATED'
    )
    AND EXISTS (
      SELECT 1 FROM publication_audience_receipts drafted
      WHERE drafted.workspace_id = NEW.workspace_id
        AND drafted.event_id = NEW.event_id
        AND drafted.channel_id = NEW.channel_id
        AND drafted.action = 'POLICY_DRAFTED'
        AND drafted.policy_version_id = NEW.policy_version_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM publication_audience_receipts invalidating
      WHERE invalidating.workspace_id = NEW.workspace_id
        AND invalidating.event_id = NEW.event_id
        AND (invalidating.channel_id = NEW.channel_id AND invalidating.action = 'CHANNEL_DISABLED'
          OR invalidating.policy_version_id = NEW.policy_version_id
            AND invalidating.action = 'POLICY_SUPERSEDED')
    )
  ))
  OR (NEW.action = 'BINDING_DISABLED' AND NOT (
    NEW.result_state = 'BLOCKED' AND NEW.policy_version_id IS NOT NULL
    AND NEW.successor_policy_version_id IS NULL AND NEW.release_version_id IS NOT NULL
    AND NEW.expected_release_id IS NOT NULL AND NEW.expected_release_version IS NOT NULL
    AND NEW.expected_release_fingerprint IS NOT NULL AND NEW.target_receipt_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM publication_audience_receipts binding
      JOIN publication_release_versions release_version
        ON release_version.id = binding.release_version_id
       AND release_version.workspace_id = binding.workspace_id
       AND release_version.event_id = binding.event_id
      WHERE binding.id = NEW.target_receipt_id
        AND binding.workspace_id = NEW.workspace_id
        AND binding.event_id = NEW.event_id
        AND binding.channel_id = NEW.channel_id
        AND binding.action = 'RELEASE_BOUND'
        AND binding.policy_version_id = NEW.policy_version_id
        AND binding.release_version_id = NEW.release_version_id
        AND release_version.release_id = NEW.expected_release_id
        AND release_version.version_number = NEW.expected_release_version
        AND release_version.release_fingerprint = NEW.expected_release_fingerprint
    )
  ))
BEGIN SELECT RAISE(ABORT, 'publication_audience_receipts binding or lifecycle mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_publication_audience_receipts_immutable
BEFORE UPDATE ON publication_audience_receipts
BEGIN SELECT RAISE(ABORT, 'publication_audience_receipts is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_publication_audience_receipts_no_delete
BEFORE DELETE ON publication_audience_receipts
BEGIN SELECT RAISE(ABORT, 'publication_audience_receipts is retained for history'); END;
`;

export const V18_DDL = `
CREATE TABLE IF NOT EXISTS observation_corrections (
  id TEXT PRIMARY KEY
    CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) BETWEEN 1 AND 160
      AND instr(id, char(0)) = 0),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  original_observation_id TEXT NOT NULL REFERENCES observations(id),
  correction_observation_id TEXT NOT NULL REFERENCES observations(id),
  reason TEXT NOT NULL
    CHECK (typeof(reason) = 'text' AND length(reason) BETWEEN 8 AND 280
      AND length(CAST(reason AS BLOB)) BETWEEN 8 AND 1120
      AND trim(reason) = reason AND instr(reason, char(0)) = 0
      AND reason NOT GLOB ('*[' || char(1) || '-' || char(31)
        || char(127) || '-' || char(159) || ']*')),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  actor_role TEXT NOT NULL
    CHECK (actor_role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')),
  corrected_at TEXT NOT NULL CHECK ${v9CanonicalInstantCheck("corrected_at")},
  idempotency_key TEXT NOT NULL
    CHECK (typeof(idempotency_key) = 'text'
      AND length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128
      AND instr(idempotency_key, char(0)) = 0),
  command_fingerprint TEXT NOT NULL
    CHECK (length(command_fingerprint) = 64
      AND command_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK (original_observation_id <> correction_observation_id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (original_observation_id),
  UNIQUE (correction_observation_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_observation_corrections_scope
  ON observation_corrections
    (workspace_id, corrected_at, original_observation_id, correction_observation_id);

CREATE TRIGGER IF NOT EXISTS trg_observation_corrections_guard
BEFORE INSERT ON observation_corrections
WHEN NEW.original_observation_id = NEW.correction_observation_id
  OR NOT EXISTS (
    SELECT 1
    FROM observations original
    JOIN observations correction
      ON correction.id = NEW.correction_observation_id
     AND correction.workspace_id = original.workspace_id
     AND correction.event_id = original.event_id
     AND correction.person_id = original.person_id
     AND correction.program_unit_id = original.program_unit_id
    JOIN events event_row
      ON event_row.id = original.event_id
     AND event_row.workspace_id = original.workspace_id
    JOIN people person
      ON person.id = original.person_id
     AND person.workspace_id = original.workspace_id
    JOIN program_units unit
      ON unit.id = original.program_unit_id
     AND unit.workspace_id = original.workspace_id
     AND unit.event_id = original.event_id
    JOIN accounts actor
      ON actor.id = NEW.actor_account_id
     AND actor.workspace_id = original.workspace_id
     AND actor.role = NEW.actor_role
     AND NEW.actor_role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
    WHERE original.id = NEW.original_observation_id
      AND original.workspace_id = NEW.workspace_id
      AND original.observation_type = 'attendance'
      AND original.source = 'organizer-live-operations'
      AND sympose_canonical_timestamp(original.observed_at) = original.observed_at
      AND original.idempotency_key = ('attendance-observation:v1:' || sympose_pd01_fingerprint(json_object(
        'schema', 'attendance-observation-key/v1',
        'workspaceId', original.workspace_id,
        'eventId', original.event_id,
        'personId', original.person_id,
        'programUnitId', original.program_unit_id,
        'observedMeaning', 'ATTENDED'
      )))
      AND correction.observation_type = 'attendance_not_attended'
      AND correction.source = 'organizer-live-operations-correction'
      AND correction.observed_at = NEW.corrected_at
      AND correction.idempotency_key = NEW.idempotency_key
      AND NEW.corrected_at > original.observed_at
  )
  OR EXISTS (
    SELECT 1 FROM observation_corrections existing
    WHERE existing.original_observation_id = NEW.original_observation_id
       OR existing.correction_observation_id = NEW.correction_observation_id
  )
  OR EXISTS (
    SELECT 1
    FROM observations original
    JOIN observations competing
      ON competing.workspace_id = original.workspace_id
     AND competing.event_id = original.event_id
     AND competing.person_id = original.person_id
     AND competing.program_unit_id = original.program_unit_id
     AND competing.observation_type = 'attendance'
     AND competing.id <> original.id
    WHERE original.id = NEW.original_observation_id
      AND original.workspace_id = NEW.workspace_id
      AND NOT EXISTS (
        SELECT 1 FROM observation_corrections supersession
        WHERE supersession.original_observation_id = competing.id
      )
  )
  OR sympose_pd01_fingerprint(json_object(
    'schema', 'attendance-correction-command/v1',
    'workspaceId', NEW.workspace_id,
    'originalObservationId', NEW.original_observation_id,
    'correctedMeaning', 'DID_NOT_ATTEND',
    'reason', NEW.reason
  )) IS NOT NEW.command_fingerprint
  OR NEW.idempotency_key IS NOT ('attendance-correction:v1:' || sympose_pd01_fingerprint(json_object(
    'schema', 'attendance-correction-key/v1',
    'workspaceId', NEW.workspace_id,
    'originalObservationId', NEW.original_observation_id,
    'correctedMeaning', 'DID_NOT_ATTEND'
  )))
BEGIN SELECT RAISE(ABORT, 'observation correction scope or lineage mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_observation_corrections_immutable
BEFORE UPDATE ON observation_corrections
BEGIN SELECT RAISE(ABORT, 'observation_corrections is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_observation_corrections_no_delete
BEFORE DELETE ON observation_corrections
BEGIN SELECT RAISE(ABORT, 'observation_corrections is retained for history'); END;
`;

export const V19_DDL = `
DROP TRIGGER IF EXISTS trg_observations_immutable;
CREATE TRIGGER trg_observations_immutable BEFORE UPDATE ON observations
BEGIN SELECT RAISE(ABORT, 'observations is immutable'); END;

DROP TRIGGER IF EXISTS trg_observations_v19_guard;
CREATE TRIGGER trg_observations_v19_guard
BEFORE INSERT ON observations
WHEN NEW.corrected_by IS NOT NULL
  OR sympose_canonical_timestamp(NEW.observed_at) IS NOT NEW.observed_at
  OR NEW.recorded_at IS NULL
  OR sympose_canonical_timestamp(NEW.recorded_at) IS NOT NEW.recorded_at
  OR NEW.observed_at > NEW.recorded_at
  OR (NEW.source = 'organizer-live-operations' AND (
    NEW.observation_type IS NOT 'attendance'
    OR NOT EXISTS (
      SELECT 1
      FROM events event_row
      JOIN program_units unit
        ON unit.workspace_id = event_row.workspace_id
       AND unit.event_id = event_row.id
       AND unit.id = NEW.program_unit_id
      WHERE event_row.workspace_id = NEW.workspace_id
        AND event_row.id = NEW.event_id
        AND event_row.lifecycle = 'live'
        AND sympose_canonical_timestamp(event_row.starts_at) = event_row.starts_at
        AND sympose_canonical_timestamp(event_row.ends_at) = event_row.ends_at
        AND sympose_canonical_timestamp(unit.starts_at) = unit.starts_at
        AND sympose_canonical_timestamp(unit.ends_at) = unit.ends_at
        AND event_row.starts_at < event_row.ends_at
        AND unit.starts_at >= event_row.starts_at
        AND unit.ends_at <= event_row.ends_at
        AND unit.starts_at < unit.ends_at
        AND NEW.recorded_at >= event_row.starts_at
        AND NEW.recorded_at < event_row.ends_at
        AND NEW.observed_at >= event_row.starts_at
        AND NEW.observed_at < event_row.ends_at
        AND NEW.observed_at >= unit.starts_at
        AND NEW.observed_at < unit.ends_at
    )
  ))
  OR (NEW.source = 'organizer-live-operations-correction' AND
      (NEW.observation_type IS NOT 'attendance_not_attended'
       OR NEW.observed_at IS NOT NEW.recorded_at))
BEGIN SELECT RAISE(ABORT, 'observation V19 authority or chronology mismatch'); END;

DROP TRIGGER IF EXISTS trg_observation_corrections_v19_guard;
CREATE TRIGGER trg_observation_corrections_v19_guard
BEFORE INSERT ON observation_corrections
WHEN NOT EXISTS (
  SELECT 1
  FROM observations original
  JOIN observations correction
    ON correction.id = NEW.correction_observation_id
   AND correction.workspace_id = original.workspace_id
  WHERE original.id = NEW.original_observation_id
    AND original.workspace_id = NEW.workspace_id
    AND original.corrected_by IS NULL
    AND correction.corrected_by IS NULL
    AND sympose_canonical_timestamp(original.recorded_at) = original.recorded_at
    AND sympose_canonical_timestamp(correction.recorded_at) = correction.recorded_at
    AND original.observed_at <= original.recorded_at
    AND correction.recorded_at >= original.recorded_at
    AND correction.observed_at = NEW.corrected_at
    AND correction.recorded_at = NEW.corrected_at
)
BEGIN SELECT RAISE(ABORT, 'observation correction V19 lineage mismatch'); END;

DROP TRIGGER IF EXISTS trg_observation_audit_v19_guard;
CREATE TRIGGER trg_observation_audit_v19_guard
BEFORE INSERT ON audit_events
WHEN (NEW.action = 'outcome.attendance.recorded' AND (
    NEW.actor_kind IS NOT 'account'
    OR NEW.target_type IS NOT 'observation'
    OR NOT EXISTS (
      SELECT 1
      FROM observations observation
      JOIN accounts actor
        ON actor.id = NEW.actor_ref
       AND actor.workspace_id = observation.workspace_id
       AND actor.role IN ('organizer', 'workspace_admin', 'event_manager', 'program_manager')
      WHERE observation.id = NEW.target_id
        AND observation.workspace_id = NEW.workspace_id
        AND observation.observation_type = 'attendance'
        AND observation.source = 'organizer-live-operations'
        AND NEW.details_json IS json_object(
          'eventId', observation.event_id,
          'personId', observation.person_id,
          'programUnitId', observation.program_unit_id,
          'observedMeaning', 'ATTENDED'
        )
        AND sympose_canonical_timestamp(NEW.created_at) = NEW.created_at
        AND NEW.created_at >= observation.recorded_at
    )
    OR EXISTS (
      SELECT 1 FROM audit_events existing
      WHERE existing.workspace_id = NEW.workspace_id
        AND existing.action = NEW.action
        AND existing.target_type = NEW.target_type
        AND existing.target_id = NEW.target_id
    )
  ))
  OR (NEW.action = 'outcome.attendance.corrected' AND (
    NEW.actor_kind IS NOT 'account'
    OR NEW.target_type IS NOT 'observation_correction'
    OR NOT EXISTS (
      SELECT 1
      FROM observation_corrections relation
      JOIN observations original ON original.id = relation.original_observation_id
      JOIN accounts actor
        ON actor.id = NEW.actor_ref
       AND actor.workspace_id = relation.workspace_id
       AND actor.id = relation.actor_account_id
       AND actor.role = relation.actor_role
      WHERE relation.id = NEW.target_id
        AND relation.workspace_id = NEW.workspace_id
        AND NEW.details_json IS json_object(
          'eventId', original.event_id,
          'originalObservationId', relation.original_observation_id,
          'correctionObservationId', relation.correction_observation_id,
          'correctedMeaning', 'DID_NOT_ATTEND',
          'commandFingerprint', relation.command_fingerprint
        )
        AND sympose_canonical_timestamp(NEW.created_at) = NEW.created_at
        AND NEW.created_at >= relation.corrected_at
    )
    OR EXISTS (
      SELECT 1 FROM audit_events existing
      WHERE existing.workspace_id = NEW.workspace_id
        AND existing.action = NEW.action
        AND existing.target_type = NEW.target_type
        AND existing.target_id = NEW.target_id
    )
  ))
BEGIN SELECT RAISE(ABORT, 'observation audit V19 evidence mismatch'); END;
`;

export const DDL = `${V19_BASE_DDL}\n${V5_DDL}\n${V6_DDL}\n${V7_DDL}\n${v9FreshV8Ddl()}\n${v11FreshV9Ddl}\n${V10_DDL}\n${V12_DDL}\n${V13_DDL}\n${V14_DDL}\n${V15_DDL}\n${V16_DDL}\n${V17_DDL}\n${V18_DDL}\n${V19_DDL}\n${V20_CONNECTOR_CONNECTIONS_DDL}\n${V21_PRODUCTION_CONNECTOR_RUNTIME_DDL}`;
function currentSpeakerAuthorityExistsSql(
  eventExpression: string,
  workspaceExpression: string,
  personExpression: string,
  assignmentExpression: string,
): string {
  return [
    "EXISTS (",
    "  SELECT 1",
    "  FROM events e",
    "  JOIN plan_versions plan ON plan.id = e.current_plan_version_id",
    "    AND plan.workspace_id = e.workspace_id AND plan.event_id = e.id",
    "  JOIN plan_assignments assignment ON assignment.plan_version_id = plan.id",
    "    AND assignment.workspace_id = plan.workspace_id AND assignment.person_id = " + personExpression,
    "  JOIN event_speakers accepted_speaker ON accepted_speaker.workspace_id = plan.workspace_id",
    "    AND accepted_speaker.event_id = e.id AND accepted_speaker.person_id = assignment.person_id",
    "    AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')",
    "    AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')",
    "  JOIN program_units unit ON unit.id = assignment.program_unit_id",
    "    AND unit.workspace_id = assignment.workspace_id AND unit.event_id = e.id",
    "  JOIN approvals approval ON approval.plan_version_id = plan.id",
    "    AND approval.workspace_id = plan.workspace_id AND approval.event_id = e.id",
    "    AND approval.decision = 'approved'",
    "  JOIN plan_states current_state ON current_state.plan_version_id = plan.id",
    "    AND current_state.workspace_id = plan.workspace_id AND current_state.state = 'approved'",
    "    AND NOT EXISTS (",
    "      SELECT 1 FROM plan_states newer_state",
    "      WHERE newer_state.workspace_id = current_state.workspace_id",
    "        AND newer_state.plan_version_id = current_state.plan_version_id",
    "        AND (newer_state.created_at > current_state.created_at",
    "          OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))",
    "    )",
    "    AND NOT EXISTS (",
    "      SELECT 1 FROM plan_states superseded_state",
    "      WHERE superseded_state.workspace_id = plan.workspace_id",
    "        AND superseded_state.plan_version_id = plan.id",
    "        AND superseded_state.state = 'superseded'",
    "    )",
    "  JOIN commitment_offers offer ON offer.plan_version_id = plan.id",
    "    AND offer.workspace_id = plan.workspace_id AND offer.event_id = e.id",
    "    AND offer.person_id = assignment.person_id",
    "  JOIN commitment_responses response ON response.offer_id = offer.id",
    "    AND response.workspace_id = offer.workspace_id AND response.actor_person_id = offer.person_id",
    "    AND response.response = 'accepted'",
    "  WHERE e.id = " + eventExpression + " AND e.workspace_id = " + workspaceExpression,
    "    AND " + normalizedSpeakerRoleMatchSql("accepted_speaker", "assignment", "offer"),
    "    AND json_extract(offer.terms_json, '$.planVersionId') = plan.id",
    "    AND json_extract(offer.terms_json, '$.eventId') = e.id",
    "    AND json_extract(offer.terms_json, '$.programUnitId') = assignment.program_unit_id",
    "    AND (SELECT COUNT(*) FROM event_speakers accepted_scope_speaker",
    "         WHERE accepted_scope_speaker.workspace_id = plan.workspace_id",
    "           AND accepted_scope_speaker.event_id = e.id",
    "           AND accepted_scope_speaker.person_id = assignment.person_id",
    "           AND accepted_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')",
    "           AND accepted_scope_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) = 1",
    "    AND (SELECT COUNT(*) FROM plan_assignments current_assignment",
    "         WHERE current_assignment.workspace_id = plan.workspace_id",
    "           AND current_assignment.plan_version_id = plan.id",
    "           AND current_assignment.person_id = assignment.person_id) = 1",
    "  GROUP BY e.id",
    "  HAVING COUNT(DISTINCT assignment.id) = 1",
    "     AND COUNT(DISTINCT accepted_speaker.id) = 1",
    "     AND COUNT(DISTINCT offer.id) = 1",
    "     AND COUNT(DISTINCT response.id) = 1",
    "     AND MIN(assignment.id) = " + assignmentExpression,
    ")"
  ].join("\n");
}
function speakerTaskAuthorityExistsSql(
  taskExpression: string,
  workspaceExpression: string,
  eventExpression: string,
  personExpression: string,
  kindExpression: string,
): string {
  return [
    "EXISTS (",
    "  SELECT 1",
    "  FROM speaker_tasks task",
    "  JOIN plan_versions plan ON plan.id = (",
    "    SELECT event_row.current_plan_version_id FROM events event_row",
    "    WHERE event_row.id = " + eventExpression + " AND event_row.workspace_id = " + workspaceExpression,
    "  )",
    "    AND plan.workspace_id = " + workspaceExpression + " AND plan.event_id = " + eventExpression,
    "  JOIN plan_assignments assignment ON assignment.id = task.assignment_id",
    "    AND assignment.workspace_id = plan.workspace_id AND assignment.plan_version_id = plan.id",
    "    AND assignment.person_id = task.person_id",
    "  JOIN event_speakers accepted_speaker ON accepted_speaker.workspace_id = plan.workspace_id",
    "    AND accepted_speaker.event_id = plan.event_id AND accepted_speaker.person_id = assignment.person_id",
    "    AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')",
    "    AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')",
    "  JOIN program_units unit ON unit.id = assignment.program_unit_id",
    "    AND unit.workspace_id = assignment.workspace_id AND unit.event_id = plan.event_id",
    "  JOIN approvals approval ON approval.plan_version_id = plan.id",
    "    AND approval.workspace_id = plan.workspace_id AND approval.event_id = plan.event_id",
    "    AND approval.decision = 'approved'",
    "  JOIN plan_states current_state ON current_state.plan_version_id = plan.id",
    "    AND current_state.workspace_id = plan.workspace_id AND current_state.state = 'approved'",
    "    AND NOT EXISTS (",
    "      SELECT 1 FROM plan_states newer_state",
    "      WHERE newer_state.workspace_id = current_state.workspace_id",
    "        AND newer_state.plan_version_id = current_state.plan_version_id",
    "        AND (newer_state.created_at > current_state.created_at",
    "          OR (newer_state.created_at = current_state.created_at AND newer_state.rowid > current_state.rowid))",
    "    )",
    "    AND NOT EXISTS (",
    "      SELECT 1 FROM plan_states superseded_state",
    "      WHERE superseded_state.workspace_id = plan.workspace_id",
    "        AND superseded_state.plan_version_id = plan.id",
    "        AND superseded_state.state = 'superseded'",
    "    )",
    "  JOIN commitment_offers offer ON offer.plan_version_id = plan.id",
    "    AND offer.workspace_id = plan.workspace_id AND offer.event_id = plan.event_id",
    "    AND offer.person_id = assignment.person_id",
    "  JOIN commitment_responses response ON response.offer_id = offer.id",
    "    AND response.workspace_id = offer.workspace_id AND response.actor_person_id = offer.person_id",
    "    AND response.response = 'accepted'",
    "  WHERE task.id = " + taskExpression,
    "    AND task.workspace_id = " + workspaceExpression,
    "    AND task.event_id = " + eventExpression,
    "    AND task.person_id = " + personExpression,
    "    AND task.content_kind = " + kindExpression,
    "    AND " + normalizedSpeakerRoleMatchSql("accepted_speaker", "assignment", "offer"),
    "    AND json_extract(offer.terms_json, '$.planVersionId') = plan.id",
    "    AND json_extract(offer.terms_json, '$.eventId') = plan.event_id",
    "    AND json_extract(offer.terms_json, '$.programUnitId') = assignment.program_unit_id",
    "    AND (SELECT COUNT(*) FROM event_speakers accepted_scope_speaker",
    "         WHERE accepted_scope_speaker.workspace_id = plan.workspace_id",
    "           AND accepted_scope_speaker.event_id = plan.event_id",
    "           AND accepted_scope_speaker.person_id = assignment.person_id",
    "           AND accepted_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')",
    "           AND accepted_scope_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) = 1",
    "    AND (SELECT COUNT(*) FROM plan_assignments current_assignment",
    "         WHERE current_assignment.workspace_id = plan.workspace_id",
    "           AND current_assignment.plan_version_id = plan.id",
    "           AND current_assignment.person_id = assignment.person_id) = 1",
    "  GROUP BY task.id, assignment.id",
    "  HAVING COUNT(DISTINCT assignment.id) = 1",
    "     AND COUNT(DISTINCT accepted_speaker.id) = 1",
    "     AND COUNT(DISTINCT offer.id) = 1",
    "     AND COUNT(DISTINCT response.id) = 1",
    ")"
  ].join("\n");
}
