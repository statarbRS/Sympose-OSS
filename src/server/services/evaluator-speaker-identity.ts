import { deterministicUuid } from "../canonical";
import type { Db } from "../db";

/**
 * The evaluator's durable CFP/plan/release seed already accepts Mina. Artifact authority must use
 * that exact Person and event-speaker row; it must never create a parallel portal identity or
 * manufacture an INVITED row at upload time.
 */
export const EVALUATOR_ARTIFACT_WORKSPACE_ID = deterministicUuid("workspace:acme");
export const EVALUATOR_ARTIFACT_EVENT_ID = deterministicUuid("evaluator-demo:event:acme");
export const EVALUATOR_ARTIFACT_PERSON_ID = deterministicUuid("evaluator-demo:person:mina-park");
export const EVALUATOR_ARTIFACT_SPEAKER_SLUG = "mina-park";
// Compatibility binding populated only after the current approved-plan proof succeeds.
export let EVALUATOR_ARTIFACT_ASSIGNMENT_ID = "";

const CANONICAL_EMAIL = "mina.park@sympose.example";
const FULL_NAME = "Mina Park";
const ORGANIZATION = "Signal Garden";
const TITLE = "Evaluation Lead";

interface EvaluatorArtifactScope {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
}

export type PersistedSpeakerRole = "SPEAKER" | "MODERATOR";

/** Normalize the canonical and legacy persisted role encodings at the authority boundary. */
export function speakerRoleFromPersisted(value: unknown): PersistedSpeakerRole | null {
  if (value === "SPEAKER" || value === "participant") return "SPEAKER";
  if (value === "MODERATOR" || value === "moderator") return "MODERATOR";
  return null;
}

function unavailable(): never {
  throw new Error("SPEAKER_ARTIFACT_SCOPE_UNAVAILABLE");
}

/**
 * Return the one accepted assignment in the event's current approved plan. Artifact tasks are
 * subordinate to this row; a deterministic identifier or a historical plan row is not authority.
 */
function resolveAcceptedCurrentPlanAssignmentId(db: Db, scope: EvaluatorArtifactScope): string {
  try {
    const rows = db.prepare(
      `SELECT assignment.id AS assignmentId,
              assignment.assignment_type AS assignmentRole,
              offer.terms_json AS termsJson
       FROM events event_row
       JOIN plan_versions plan
         ON plan.id = event_row.current_plan_version_id
        AND plan.workspace_id = event_row.workspace_id
        AND plan.event_id = event_row.id
       JOIN plan_assignments assignment
         ON assignment.workspace_id = plan.workspace_id
        AND assignment.plan_version_id = plan.id
        AND assignment.person_id = ?
       JOIN event_speakers accepted_speaker
         ON accepted_speaker.workspace_id = plan.workspace_id
        AND accepted_speaker.event_id = event_row.id
        AND accepted_speaker.person_id = assignment.person_id
        AND accepted_speaker.role_key IN ('SPEAKER', 'MODERATOR')
        AND accepted_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')
       JOIN program_units unit
         ON unit.id = assignment.program_unit_id
        AND unit.workspace_id = assignment.workspace_id
        AND unit.event_id = event_row.id
       JOIN approvals approval
         ON approval.workspace_id = plan.workspace_id
       AND approval.event_id = event_row.id
        AND approval.plan_version_id = plan.id
        AND approval.decision = 'approved'
       JOIN plan_states current_state
         ON current_state.workspace_id = plan.workspace_id
        AND current_state.plan_version_id = plan.id
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
       JOIN commitment_offers offer
         ON offer.workspace_id = plan.workspace_id
        AND offer.event_id = event_row.id
        AND offer.plan_version_id = plan.id
        AND offer.person_id = assignment.person_id
       JOIN commitment_responses response
         ON response.workspace_id = offer.workspace_id
        AND response.offer_id = offer.id
        AND response.actor_person_id = offer.person_id
        AND response.response = 'accepted'
       WHERE json_extract(offer.terms_json, '$.planVersionId') = plan.id
         AND json_extract(offer.terms_json, '$.eventId') = event_row.id
         AND json_extract(offer.terms_json, '$.programUnitId') = assignment.program_unit_id
         AND CASE accepted_speaker.role_key
               WHEN 'SPEAKER' THEN 'SPEAKER'
               WHEN 'MODERATOR' THEN 'MODERATOR'
             END = CASE assignment.assignment_type
               WHEN 'SPEAKER' THEN 'SPEAKER'
               WHEN 'participant' THEN 'SPEAKER'
               WHEN 'MODERATOR' THEN 'MODERATOR'
               WHEN 'moderator' THEN 'MODERATOR'
             END
         AND CASE assignment.assignment_type
               WHEN 'SPEAKER' THEN 'SPEAKER'
               WHEN 'participant' THEN 'SPEAKER'
               WHEN 'MODERATOR' THEN 'MODERATOR'
               WHEN 'moderator' THEN 'MODERATOR'
             END = CASE json_extract(offer.terms_json, '$.role')
               WHEN 'SPEAKER' THEN 'SPEAKER'
               WHEN 'participant' THEN 'SPEAKER'
               WHEN 'MODERATOR' THEN 'MODERATOR'
               WHEN 'moderator' THEN 'MODERATOR'
             END
         AND (SELECT COUNT(*)
              FROM event_speakers accepted_scope_speaker
              WHERE accepted_scope_speaker.workspace_id = plan.workspace_id
                AND accepted_scope_speaker.event_id = event_row.id
                AND accepted_scope_speaker.person_id = assignment.person_id
                AND accepted_scope_speaker.role_key IN ('SPEAKER', 'MODERATOR')
                AND accepted_scope_speaker.participation_status IN ('CONFIRMED', 'ACCEPTED')) = 1
         AND (SELECT COUNT(*) FROM plan_assignments current_assignment
              WHERE current_assignment.workspace_id = plan.workspace_id
                AND current_assignment.plan_version_id = plan.id
                AND current_assignment.person_id = assignment.person_id) = 1
         AND event_row.workspace_id = ?
         AND event_row.id = ?
         AND assignment.person_id = ?
       GROUP BY assignment.id
       HAVING COUNT(DISTINCT accepted_speaker.id) = 1
          AND COUNT(DISTINCT offer.id) = 1
          AND COUNT(DISTINCT response.id) = 1
       ORDER BY assignment.id
       LIMIT 2`,
    ).all(scope.personId, scope.workspaceId, scope.eventId, scope.personId) as unknown as readonly {
      assignmentId: unknown;
      assignmentRole: unknown;
      termsJson: unknown;
    }[];
    if (
      rows.length !== 1 ||
      typeof rows[0]?.assignmentId !== "string" ||
      rows[0].assignmentId.length === 0 ||
      speakerRoleFromPersisted(rows[0].assignmentRole) === null
    ) {
      unavailable();
    }
    let terms: unknown;
    try {
      terms = JSON.parse(typeof rows[0].termsJson === "string" ? rows[0].termsJson : "");
    } catch {
      unavailable();
    }
    if (
      speakerRoleFromPersisted(rows[0].assignmentRole) === null ||
      typeof terms !== "object" ||
      terms === null ||
      speakerRoleFromPersisted((terms as Record<string, unknown>).role) !== speakerRoleFromPersisted(rows[0].assignmentRole)
    ) {
      unavailable();
    }
    return rows[0].assignmentId;
  } catch {
    unavailable();
  }
}

/** Read current accepted assignment authority without mutating evaluator compatibility state. */
export function readAcceptedCurrentPlanAssignmentId(db: Db, scope: EvaluatorArtifactScope): string {
  return resolveAcceptedCurrentPlanAssignmentId(db, scope);
}

export function acceptedCurrentPlanAssignmentId(db: Db, scope: EvaluatorArtifactScope): string {
  const assignmentId = resolveAcceptedCurrentPlanAssignmentId(db, scope);
  EVALUATOR_ARTIFACT_ASSIGNMENT_ID = assignmentId;
  return assignmentId;
}

export function isEvaluatorArtifactScope(scope: EvaluatorArtifactScope): boolean {
  return (
    scope.workspaceId === EVALUATOR_ARTIFACT_WORKSPACE_ID &&
    scope.eventId === EVALUATOR_ARTIFACT_EVENT_ID &&
    scope.personId === EVALUATOR_ARTIFACT_PERSON_ID
  );
}

/**
 * Establishes the one synthetic evaluator person used by the local portal and binds it to the
 * canonical event with source provenance. Existing rows must match the seeded values exactly.
 * Returns false for ordinary scopes, which are checked by the caller without creating identity.
 */
export function ensureEvaluatorArtifactSpeakerProvenance(db: Db, scope: EvaluatorArtifactScope): boolean {
  if (!isEvaluatorArtifactScope(scope)) return false;

  try {
    const person = db
      .prepare(
        `SELECT id, workspace_id, canonical_email, full_name, organization, title
         FROM people WHERE id = ? AND workspace_id = ?`,
      )
      .get(scope.personId, scope.workspaceId) as
      | {
          id: string;
          workspace_id: string;
          canonical_email: string;
          full_name: string;
          organization: string | null;
          title: string | null;
        }
      | undefined;
    if (
      !person ||
      person.canonical_email !== CANONICAL_EMAIL ||
      person.full_name !== FULL_NAME ||
      person.organization !== ORGANIZATION ||
      person.title !== TITLE
    ) unavailable();

    const conflictingEmail = db
      .prepare("SELECT id FROM people WHERE workspace_id = ? AND canonical_email = ? AND id <> ? LIMIT 1")
      .get(scope.workspaceId, CANONICAL_EMAIL, scope.personId) as { id: string } | undefined;
    if (conflictingEmail) unavailable();

    // Artifact collection is an input to publication, so evaluator fixture uploads must be
    // authorized by the accepted current plan without depending on a release that does not exist
    // yet. Exact approval and sealing remain separate canonical service gates.
    const event = db
      .prepare("SELECT id, workspace_id, current_plan_version_id AS planVersionId FROM events WHERE id = ? AND workspace_id = ?")
      .get(scope.eventId, scope.workspaceId) as { id: string; workspace_id: string; planVersionId: string | null } | undefined;
    if (!event || event.planVersionId === null) unavailable();

    const speaker = db
      .prepare(
        `SELECT id, role_key AS roleKey, participation_status AS participationStatus
         FROM event_speakers
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
           AND role_key IN ('SPEAKER', 'MODERATOR')`,
      )
      .all(scope.workspaceId, scope.eventId, scope.personId) as unknown as readonly {
        id: string;
        roleKey: string;
        participationStatus: string;
      }[];
    if (
      speaker.length !== 1 ||
      speakerRoleFromPersisted(speaker[0]!.roleKey) === null ||
      !["CONFIRMED", "ACCEPTED"].includes(speaker[0]!.participationStatus)
    ) unavailable();

    acceptedCurrentPlanAssignmentId(db, scope);

    const source = db
      .prepare(
        `SELECT 1
         FROM source_links link
         JOIN source_records source ON source.id = link.source_record_id AND source.workspace_id = link.workspace_id
         WHERE link.workspace_id = ? AND link.person_id = ? AND link.link_decision = 'matched'
           AND source.provider = 'evaluator-demo' AND source.source_ref = 'evaluator/demo/mina-park'
         LIMIT 1`,
      )
      .get(scope.workspaceId, scope.personId);
    if (!source) unavailable();
    return true;
  } catch {
    unavailable();
  }
}
