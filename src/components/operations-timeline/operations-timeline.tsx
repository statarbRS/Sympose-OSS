import type { Db } from "@/server/db";

import styles from "./operations-timeline.module.css";

export type OperationsTimelineStage =
  | "proposal"
  | "decision"
  | "commitment"
  | "artifact"
  | "schedule"
  | "approval"
  | "publication"
  | "operational";

export type OperationsTruthLayer =
  | "Candidate evidence"
  | "Decision truth"
  | "Commitment truth"
  | "Operational truth"
  | "Evidence / provenance"
  | "Scheduling record"
  | "Published projection";

export interface OperationsTimelineEntry {
  readonly id: string;
  readonly stage: OperationsTimelineStage;
  readonly truthLayer: OperationsTruthLayer;
  readonly occurredAt: string;
  readonly title: string;
  readonly detail: string;
  readonly source: string;
  readonly sourceId: string;
  readonly fingerprint: string | null;
}

export interface OperationsTimelineStageState {
  readonly stage: OperationsTimelineStage;
  readonly label: string;
  readonly count: number;
  readonly truncated: boolean;
  readonly missingMessage: string;
}

export interface OperationsTimelineProjection {
  readonly entries: readonly OperationsTimelineEntry[];
  readonly stages: readonly OperationsTimelineStageState[];
  readonly truncated: boolean;
}

type TimelineRow = Record<string, unknown>;

export const OPERATIONS_TIMELINE_LIMIT = 500;
const QUERY_LIMIT = OPERATIONS_TIMELINE_LIMIT + 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const TRUTH_LAYERS = new Set<OperationsTruthLayer>([
  "Candidate evidence",
  "Decision truth",
  "Commitment truth",
  "Operational truth",
  "Evidence / provenance",
  "Scheduling record",
  "Published projection",
]);

const STAGES: ReadonlyArray<Omit<OperationsTimelineStageState, "count" | "truncated">> = [
  {
    stage: "proposal",
    label: "Proposal submitted",
    missingMessage: "No submitted proposal record exists for this event.",
  },
  {
    stage: "decision",
    label: "Proposal decided",
    missingMessage: "No proposal decision record exists for this event.",
  },
  {
    stage: "commitment",
    label: "Commitment response",
    missingMessage: "No commitment response record exists for this event.",
  },
  {
    stage: "artifact",
    label: "Speaker artifact",
    missingMessage: "No persisted speaker artifact record exists for this event.",
  },
  {
    stage: "schedule",
    label: "Scheduling",
    missingMessage: "No persisted session allocation exists for this event.",
  },
  {
    stage: "approval",
    label: "Approval",
    missingMessage: "No plan or speaker-content approval record exists for this event.",
  },
  {
    stage: "publication",
    label: "Release publication",
    missingMessage: "No sealed publication release exists for this event.",
  },
  {
    stage: "operational",
    label: "Observed outcome",
    missingMessage: "No operational observation exists for this event.",
  },
];

const STAGE_ORDER = new Map(STAGES.map((stage, index) => [stage.stage, index]));
const STAGE_NAMES = new Set(STAGES.map((stage) => stage.stage));

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL_CHARACTER.test(value)
    ? value
    : null;
}

function normalizeTimelineRow(row: TimelineRow): OperationsTimelineEntry {
  const id = boundedString(row.id, 160);
  const sourceId = boundedString(row.sourceId, 160);
  const occurredAt = boundedString(row.occurredAt, 80);
  const title = boundedString(row.title, 160);
  const detail = boundedString(row.detail, 640);
  const source = boundedString(row.source, 200);
  const fingerprint = row.fingerprint === null ? null : boundedString(row.fingerprint, 256);
  if (
    Object.keys(row).length !== 9 ||
    !id || !SAFE_ID.test(id) ||
    !sourceId || !SAFE_ID.test(sourceId) ||
    !occurredAt || new Date(occurredAt).toISOString() !== occurredAt ||
    !title || !detail || !source ||
    (row.fingerprint !== null && !fingerprint) ||
    typeof row.stage !== "string" || !STAGE_NAMES.has(row.stage as OperationsTimelineStage) ||
    typeof row.truthLayer !== "string" || !TRUTH_LAYERS.has(row.truthLayer as OperationsTruthLayer)
  ) {
    throw new Error("OPERATIONS_TIMELINE_RECORD_INVALID");
  }
  return Object.freeze({
    id,
    stage: row.stage as OperationsTimelineStage,
    truthLayer: row.truthLayer as OperationsTruthLayer,
    occurredAt,
    title,
    detail,
    source,
    sourceId,
    fingerprint,
  });
}

function compareEntries(left: OperationsTimelineEntry, right: OperationsTimelineEntry): number {
  const byTime = left.occurredAt.localeCompare(right.occurredAt);
  if (byTime !== 0) return byTime;
  const byStage = (STAGE_ORDER.get(left.stage) ?? STAGES.length) - (STAGE_ORDER.get(right.stage) ?? STAGES.length);
  if (byStage !== 0) return byStage;
  return left.id.localeCompare(right.id);
}

function proposalRows(db: Db, workspaceId: string, eventId: string): TimelineRow[] {
  return db.prepare(
    `SELECT submission.id AS id,
            'proposal' AS stage,
            'Candidate evidence' AS truthLayer,
            submission.updated_at AS occurredAt,
            'Proposal submitted' AS title,
            'Persisted submitted-state record; this time belongs to the current submission row.' AS detail,
            'submissions' AS source,
            submission.id AS sourceId,
            revision.fingerprint AS fingerprint
     FROM submissions submission
     JOIN calls call_row
       ON call_row.id = submission.call_id
      AND call_row.workspace_id = submission.workspace_id
      AND call_row.event_id = submission.event_id
     JOIN submission_revisions revision
       ON revision.id = submission.current_revision_id
      AND revision.workspace_id = submission.workspace_id
      AND revision.submission_id = submission.id
     WHERE submission.workspace_id = ?
       AND submission.event_id = ?
       AND submission.state = 'SUBMITTED'
     ORDER BY submission.updated_at DESC, submission.id DESC
     LIMIT ${QUERY_LIMIT}`,
  ).all(workspaceId, eventId) as unknown as TimelineRow[];
}

function decisionRows(db: Db, workspaceId: string, eventId: string): TimelineRow[] {
  return db.prepare(
    `SELECT event_row.id AS id,
            'decision' AS stage,
            'Decision truth' AS truthLayer,
            event_row.created_at AS occurredAt,
            CASE json_extract(event_row.payload_json, '$.decision')
              WHEN 'ACCEPTED' THEN 'Proposal accepted'
              ELSE 'Proposal rejected'
            END AS title,
            'An organizer decision is retained as an immutable domain event.' AS detail,
            'domain_events · cfp.submission.decision' AS source,
            event_row.id AS sourceId,
            event_row.payload_fingerprint AS fingerprint
     FROM domain_events event_row
     JOIN submissions submission
       ON submission.id = event_row.aggregate_id
      AND submission.workspace_id = event_row.workspace_id
      AND submission.event_id = ?
     WHERE event_row.workspace_id = ?
       AND event_row.event_type = 'cfp.submission.decision'
       AND event_row.aggregate_type = 'cfp_submission'
       AND json_extract(event_row.payload_json, '$.workspaceId') = event_row.workspace_id
       AND json_extract(event_row.payload_json, '$.eventId') = submission.event_id
       AND json_extract(event_row.payload_json, '$.submissionId') = submission.id
       AND json_extract(event_row.payload_json, '$.decision') IN ('ACCEPTED', 'REJECTED')
     ORDER BY event_row.created_at DESC, event_row.id DESC
     LIMIT ${QUERY_LIMIT}`,
  ).all(eventId, workspaceId) as unknown as TimelineRow[];
}

function commitmentRows(db: Db, workspaceId: string, eventId: string): TimelineRow[] {
  return db.prepare(
    `SELECT response.id AS id,
            'commitment' AS stage,
            'Commitment truth' AS truthLayer,
            response.responded_at AS occurredAt,
            CASE response.response
              WHEN 'accepted' THEN 'Commitment accepted'
              ELSE 'Commitment declined'
            END AS title,
            'A participant responded to exact persisted offer terms.' AS detail,
            'commitment_responses · commitment_offers' AS source,
            response.id AS sourceId,
            offer.terms_fingerprint AS fingerprint
     FROM commitment_responses response
     JOIN commitment_offers offer
       ON offer.id = response.offer_id
      AND offer.workspace_id = response.workspace_id
      AND offer.event_id = ?
     JOIN plan_versions plan
       ON plan.id = offer.plan_version_id
      AND plan.workspace_id = offer.workspace_id
      AND plan.event_id = offer.event_id
     WHERE response.workspace_id = ?
       AND response.response IN ('accepted', 'declined')
     ORDER BY response.responded_at DESC, response.id DESC
     LIMIT ${QUERY_LIMIT}`,
  ).all(eventId, workspaceId) as unknown as TimelineRow[];
}

function artifactRows(db: Db, workspaceId: string, eventId: string): TimelineRow[] {
  return db.prepare(
    `SELECT artifact.id AS id,
            'artifact' AS stage,
            'Evidence / provenance' AS truthLayer,
            artifact.created_at AS occurredAt,
            CASE artifact.kind
              WHEN 'HEADSHOT' THEN 'Speaker headshot persisted'
              ELSE 'Speaker slides persisted'
            END AS title,
            'An immutable speaker artifact record was stored with content lineage.' AS detail,
            'artifact_records · speaker.artifact.submitted' AS source,
            artifact.id AS sourceId,
            artifact.sha256 AS fingerprint
     FROM artifact_records artifact
     JOIN speaker_tasks task
       ON task.id = artifact.task_id
      AND task.workspace_id = artifact.workspace_id
      AND task.event_id = artifact.event_id
      AND task.person_id = artifact.person_id
     JOIN domain_events authority
       ON authority.id = artifact.authority_event_id
      AND authority.workspace_id = artifact.workspace_id
      AND authority.event_type = 'speaker.artifact.submitted'
      AND authority.aggregate_type = 'speaker_task'
      AND authority.aggregate_id = artifact.task_id
     WHERE artifact.workspace_id = ?
       AND artifact.event_id = ?
     ORDER BY artifact.created_at DESC, artifact.id DESC
     LIMIT ${QUERY_LIMIT}`,
  ).all(workspaceId, eventId) as unknown as TimelineRow[];
}

function scheduleRows(db: Db, workspaceId: string, eventId: string): TimelineRow[] {
  return db.prepare(
    `SELECT allocation.id AS id,
            'schedule' AS stage,
            'Scheduling record' AS truthLayer,
            allocation.updated_at AS occurredAt,
            CASE allocation.allocation_status
              WHEN 'PUBLISHED' THEN 'Session allocation published'
              WHEN 'CANCELLED' THEN 'Session allocation cancelled'
              ELSE 'Session allocation saved'
            END AS title,
            unit.name || ' · ' || room.name || ' · ' || allocation.starts_at AS detail,
            'event_session_allocations' AS source,
            allocation.id AS sourceId,
            NULL AS fingerprint
     FROM event_session_allocations allocation
     JOIN program_units unit
       ON unit.id = allocation.program_unit_id
      AND unit.workspace_id = allocation.workspace_id
      AND unit.event_id = allocation.event_id
     JOIN event_rooms room
       ON room.id = allocation.room_id
      AND room.workspace_id = allocation.workspace_id
      AND room.event_id = allocation.event_id
     WHERE allocation.workspace_id = ?
       AND allocation.event_id = ?
     ORDER BY allocation.updated_at DESC, allocation.id DESC
     LIMIT ${QUERY_LIMIT}`,
  ).all(workspaceId, eventId) as unknown as TimelineRow[];
}

function approvalRows(db: Db, workspaceId: string, eventId: string): TimelineRow[] {
  const plans = db.prepare(
    `SELECT approval.id AS id,
            'approval' AS stage,
            'Decision truth' AS truthLayer,
            approval.created_at AS occurredAt,
            'Plan approved' AS title,
            'Organizer approval references an immutable plan version.' AS detail,
            'approvals · plan_versions' AS source,
            approval.id AS sourceId,
            plan.fingerprint AS fingerprint
     FROM approvals approval
     JOIN plan_versions plan
       ON plan.id = approval.plan_version_id
      AND plan.workspace_id = approval.workspace_id
      AND plan.event_id = approval.event_id
     WHERE approval.workspace_id = ?
       AND approval.event_id = ?
       AND approval.decision = 'approved'
     ORDER BY approval.created_at DESC, approval.id DESC
     LIMIT ${QUERY_LIMIT}`,
  ).all(workspaceId, eventId) as unknown as TimelineRow[];
  const content = db.prepare(
    `SELECT review.id AS id,
            'approval' AS stage,
            'Decision truth' AS truthLayer,
            review.reviewed_at AS occurredAt,
            'Speaker content approved' AS title,
            'Organizer review approved an exact speaker-content version for ' || lower(review.gate) || '.' AS detail,
            'speaker_content_reviews · speaker_content_versions' AS source,
            review.id AS sourceId,
            review.submission_content_hash AS fingerprint
     FROM speaker_content_reviews review
     JOIN speaker_content_versions version
       ON version.id = review.submission_version_id
      AND version.workspace_id = review.workspace_id
      AND version.event_id = review.event_id
      AND version.person_id = review.person_id
      AND version.task_id = review.task_id
      AND version.content_hash = review.submission_content_hash
     WHERE review.workspace_id = ?
       AND review.event_id = ?
       AND review.review_state = 'APPROVED'
     ORDER BY review.reviewed_at DESC, review.id DESC
     LIMIT ${QUERY_LIMIT}`,
  ).all(workspaceId, eventId) as unknown as TimelineRow[];
  return [...plans, ...content];
}

function publicationRows(db: Db, workspaceId: string, eventId: string): TimelineRow[] {
  return db.prepare(
    `SELECT release.id AS id,
            'publication' AS stage,
            'Published projection' AS truthLayer,
            release.sealed_at AS occurredAt,
            'Audience release published' AS title,
            'A sealed audience projection was materialized from one exact plan and commitment watermark.' AS detail,
            'publication_releases' AS source,
            release.id AS sourceId,
            release.fingerprint AS fingerprint
     FROM publication_releases release
     JOIN plan_versions plan
       ON plan.id = release.plan_version_id
      AND plan.workspace_id = release.workspace_id
      AND plan.event_id = release.event_id
     WHERE release.workspace_id = ?
       AND release.event_id = ?
     ORDER BY release.sealed_at DESC, release.id DESC
     LIMIT ${QUERY_LIMIT}`,
  ).all(workspaceId, eventId) as unknown as TimelineRow[];
}

function operationalRows(db: Db, workspaceId: string, eventId: string): TimelineRow[] {
  return db.prepare(
    `SELECT observation.id AS id,
            'operational' AS stage,
            'Operational truth' AS truthLayer,
            observation.observed_at AS occurredAt,
            CASE
              WHEN correction_relation.id IS NOT NULL THEN 'Attendance corrected: did not attend'
              WHEN original_relation.id IS NOT NULL THEN 'Attendance originally observed — superseded'
              WHEN observation.observation_type = 'attendance' THEN 'Attendance observed'
              ELSE 'Operational observation recorded'
            END AS title,
            CASE
              WHEN correction_relation.id IS NOT NULL THEN
                substr(unit.name, 1, 80) || CASE WHEN length(unit.name) > 80 THEN '…' ELSE '' END ||
                ' · correction reason: ' || substr(correction_relation.reason, 1, 120) ||
                CASE WHEN length(correction_relation.reason) > 120 THEN '…' ELSE '' END ||
                ' · recorded by ' || correction_relation.actor_role || ' at ' ||
                correction_relation.corrected_at || ' · ingested at ' ||
                observation.recorded_at || ' · current'
              WHEN original_relation.id IS NOT NULL THEN
                substr(unit.name, 1, 80) || CASE WHEN length(unit.name) > 80 THEN '…' ELSE '' END ||
                ' · original attended observation · superseded at ' ||
                original_relation.corrected_at || ' · reason: ' || substr(original_relation.reason, 1, 120) ||
                CASE WHEN length(original_relation.reason) > 120 THEN '…' ELSE '' END ||
                ' · ingested at ' || observation.recorded_at
              ELSE unit.name || ' · occurred at ' || observation.observed_at ||
                ' · ingested at ' || observation.recorded_at ||
                ' · observed by ' || observation.source
            END AS detail,
            CASE WHEN correction_relation.id IS NOT NULL OR original_relation.id IS NOT NULL
              THEN 'observations · observation_corrections'
              ELSE 'observations'
            END AS source,
            observation.id AS sourceId,
            COALESCE(correction_relation.command_fingerprint,
                     original_relation.command_fingerprint) AS fingerprint
     FROM observations observation
     JOIN program_units unit
       ON unit.id = observation.program_unit_id
      AND unit.workspace_id = observation.workspace_id
      AND unit.event_id = observation.event_id
     JOIN people person
      ON person.id = observation.person_id
      AND person.workspace_id = observation.workspace_id
     LEFT JOIN observation_corrections original_relation
       ON original_relation.workspace_id = observation.workspace_id
      AND original_relation.original_observation_id = observation.id
     LEFT JOIN observation_corrections correction_relation
       ON correction_relation.workspace_id = observation.workspace_id
      AND correction_relation.correction_observation_id = observation.id
     WHERE observation.workspace_id = ?
       AND observation.event_id = ?
     ORDER BY observation.observed_at DESC, observation.id DESC
     LIMIT ${QUERY_LIMIT}`,
  ).all(workspaceId, eventId) as unknown as TimelineRow[];
}

/**
 * Builds a read-only event ledger from existing persisted records. Every query carries the
 * authenticated workspace and event scope; rows from other events or tenants never enter the
 * projection, even when an identifier is reused in hostile fixtures.
 */
export function getOperationsTimeline(
  db: Db,
  workspaceId: string,
  eventId: string,
): OperationsTimelineProjection {
  const availableEntries = [
    ...proposalRows(db, workspaceId, eventId),
    ...decisionRows(db, workspaceId, eventId),
    ...commitmentRows(db, workspaceId, eventId),
    ...artifactRows(db, workspaceId, eventId),
    ...scheduleRows(db, workspaceId, eventId),
    ...approvalRows(db, workspaceId, eventId),
    ...publicationRows(db, workspaceId, eventId),
    ...operationalRows(db, workspaceId, eventId),
  ].map(normalizeTimelineRow).sort(compareEntries);
  const counts = new Map<OperationsTimelineStage, number>();
  for (const entry of availableEntries) counts.set(entry.stage, (counts.get(entry.stage) ?? 0) + 1);
  const truncated = availableEntries.length > OPERATIONS_TIMELINE_LIMIT;
  const entries = truncated ? availableEntries.slice(-OPERATIONS_TIMELINE_LIMIT) : availableEntries;
  return Object.freeze({
    entries: Object.freeze(entries),
    stages: Object.freeze(STAGES.map((stage) => Object.freeze({
      ...stage,
      count: Math.min(counts.get(stage.stage) ?? 0, OPERATIONS_TIMELINE_LIMIT),
      truncated: (counts.get(stage.stage) ?? 0) > OPERATIONS_TIMELINE_LIMIT,
    }))),
    truncated,
  });
}

function formatTimestamp(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function shortEvidence(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

export function OperationsTimeline({
  projection,
  timezone,
}: {
  readonly projection: OperationsTimelineProjection;
  readonly timezone: string;
}) {
  const presentStages = projection.stages.filter((stage) => stage.count > 0).length;
  return (
    <div className={styles.timelineSurface} data-testid="operations-timeline">
      <div className={styles.summary} aria-label="Persisted activity coverage">
        <div><strong>{projection.entries.length}</strong><span>record-backed activities shown</span></div>
        <div><strong>{presentStages}/{projection.stages.length}</strong><span>stages with evidence</span></div>
        <div><strong>Read only</strong><span>no controls or inferred activity</span></div>
      </div>

      {projection.truncated ? (
        <p className={styles.limitNotice} role="status">
          Showing the latest {OPERATIONS_TIMELINE_LIMIT} activities. Older persisted activity is omitted from this bounded view.
        </p>
      ) : null}

      {projection.entries.length === 0 ? (
        <div className={styles.empty} role="status">
          <strong>No operational activity records exist for this event.</strong>
          <span>Event lifecycle and dates never manufacture progress in this ledger.</span>
        </div>
      ) : (
        <ol className={styles.timeline} aria-label="Chronological event activity">
          {projection.entries.map((entry) => (
            <li key={`${entry.stage}:${entry.id}`} className={styles.entry} data-stage={entry.stage}>
              <div className={styles.marker} aria-hidden="true" />
              <article>
                <header className={styles.entryHeader}>
                  <div>
                    <span className={styles.layer} data-layer={entry.truthLayer}>{entry.truthLayer}</span>
                    <h3>{entry.title}</h3>
                  </div>
                  <time dateTime={entry.occurredAt}>{formatTimestamp(entry.occurredAt, timezone)}</time>
                </header>
                <p>{entry.detail}</p>
                <dl className={styles.provenance}>
                  <div><dt>Source</dt><dd>{entry.source}</dd></div>
                  <div><dt>Record</dt><dd><code title={entry.sourceId}>{shortEvidence(entry.sourceId)}</code></dd></div>
                  {entry.fingerprint ? <div><dt>Fingerprint</dt><dd><code title={entry.fingerprint}>{shortEvidence(entry.fingerprint)}</code></dd></div> : null}
                </dl>
              </article>
            </li>
          ))}
        </ol>
      )}

      <section className={styles.coverage} aria-labelledby="operations-coverage-title">
        <div className={styles.coverageHeading}>
          <div><span className={styles.kicker}>Evidence coverage</span><h3 id="operations-coverage-title">What exists—and what does not</h3></div>
          <p>Missing means no matching persisted record was found in this workspace and event.</p>
        </div>
        <ul className={styles.stageGrid}>
          {projection.stages.map((stage) => (
            <li key={stage.stage} data-state={stage.count > 0 ? "present" : "missing"}>
              <span aria-hidden="true">{stage.count > 0 ? "✓" : "—"}</span>
              <div><strong>{stage.label}</strong><small>{stage.count > 0 ? `${stage.count}${stage.truncated ? "+" : ""} persisted ${stage.count === 1 ? "record" : "records"}` : stage.missingMessage}</small></div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
