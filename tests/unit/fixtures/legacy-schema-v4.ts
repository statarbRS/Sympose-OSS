import { DatabaseSync } from "node:sqlite";

export const V4_FIXTURE_BASE_COMMIT = "32fb5fdbe7616e2258dc17f8706a1310113e5902";
export const V4_SCHEMA_MANIFEST_SHA256 =
  "6c53baf5366e56ddafc29efa0cbf1ee4b27dd17630cab194904c6629b870d9d7";

export const V4_SCHEMA_SQL = `PRAGMA foreign_keys = ON;
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

CREATE TABLE IF NOT EXISTS cfp_email_verifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  call_id TEXT NOT NULL REFERENCES calls(id),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL CHECK (length(token_hash) BETWEEN 1 AND 128),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, call_id, email, token_hash)
);

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

export function createLegacyV4Database(options?: { readonly path?: string }): DatabaseSync {
  const path = options?.path ?? ":memory:";
  const db = new DatabaseSync(path);
  db.exec(V4_SCHEMA_SQL);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run();
  return db;
}
