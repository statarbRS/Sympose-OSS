import { createHash } from "node:crypto";

import { withTransactionOrSavepoint, type Db } from "./db";
import { createSession } from "./auth";
import { canonicalJson, deterministicUuid, fingerprintOf, nowIso, sha256Hex } from "./canonical";
import {
  BLIND_REVIEW_ATTESTATION,
  BLIND_REVIEW_DISCLOSURE_STAGE,
  type BlindFieldDecisionInput,
} from "./services/cfp-review/artifact-types";
import {
  sealBlindReviewArtifact,
  sealRubricSemantics,
} from "./services/cfp-review/organizer";
import {
  createCfpPersistence,
  readSubmissionRevision,
} from "./services/cfp/form-documents";
import { FORM_RULES_SCHEMA } from "./services/cfp/form-evaluator";
import { submitSubmission } from "./services/cfp/submissions";
import { approvePlan, compilePlan } from "./services/planning";
import {
  commitmentResponseCommandKey,
  deliverOffers,
  respondToOfferCommand,
} from "./services/commitments";
import { sealRelease } from "./services/publication";
import {
  approveScheduleDraft,
  readCurrentScheduleApproval,
  scheduleApprovalSubject,
} from "./services/scheduling/approval";
import { executeScheduleDraftCommand, readScheduleDraft } from "./services/scheduling/persistence";
import { createSyntheticSpeakerOperationsRepository } from "./services/speaker-operations";
import { seedEvaluatorCompatibility } from "./evaluator-compatibility";
import {
  createSpeakerArtifactRecord,
  listSpeakerArtifactRecords,
  readSpeakerArtifact,
  type ArtifactRecordServiceOptions,
  type SpeakerArtifactRecord,
} from "./services/artifact-records";

export {
  DEVFLOW_EVALUATOR_PROFILE,
  EVALUATOR_COMPATIBILITY_ASSIGNMENT_ID,
  EVALUATOR_COMPATIBILITY_ACCOUNT_PERSON_BINDING_ID,
  EVALUATOR_COMPATIBILITY_CALL_ID,
  EVALUATOR_COMPATIBILITY_CALL_SLUG,
  EVALUATOR_COMPATIBILITY_EVENT_ID,
  EVALUATOR_COMPATIBILITY_EVENT_REVIEWER_ASSIGNMENT_ID,
  EVALUATOR_COMPATIBILITY_MARCUS_PERSON_ID,
  EVALUATOR_COMPATIBILITY_MARCUS_SUBMISSION_ID,
  EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
  EVALUATOR_COMPATIBILITY_PRIYA_SUBMISSION_ID,
  EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
  EVALUATOR_COMPATIBILITY_SAM_PERSON_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  EVALUATOR_COMPATIBILITY_WORKSPACE_NAME,
  EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
  seedEvaluatorCompatibility,
} from "./evaluator-compatibility";

export const EVALUATOR_WORKSPACE_SLUG = "acme" as const;
export const EVALUATOR_CALL_SLUG = "stagecraft-2026" as const;

export const EVALUATOR_WORKSPACE_ID = deterministicUuid("workspace:acme");
export const EVALUATOR_ORGANIZER_ACCOUNT_ID = deterministicUuid("account:acme-organizer");
export const EVALUATOR_REVIEWER_ACCOUNT_ID = deterministicUuid("account:evaluator-acme-reviewer");
export const EVALUATOR_EVENT_ID = deterministicUuid("evaluator-demo:event:acme");
export const EVALUATOR_PROGRAM_UNIT_ID = deterministicUuid("evaluator-demo:program-unit:acme");
export const EVALUATOR_FORM_DEFINITION_ID = deterministicUuid("evaluator-demo:form-definition:acme");
export const EVALUATOR_FORM_VERSION_ID = deterministicUuid("evaluator-demo:form-version:acme");
export const EVALUATOR_RULE_VERSION_ID = deterministicUuid("evaluator-demo:rule-version:acme");
export const EVALUATOR_CALL_ID = deterministicUuid("evaluator-demo:call:acme");
export const EVALUATOR_ROUND_ID = deterministicUuid("evaluator-demo:review-round:acme");
export const EVALUATOR_RUBRIC_VERSION_ID = deterministicUuid("evaluator-demo:rubric:acme");
export const EVALUATOR_ASSIGNMENT_ID = deterministicUuid("evaluator-demo:assignment:acme");
export const EVALUATOR_SPEAKER_PERSON_ID = deterministicUuid("evaluator-demo:person:mina-park");
export const EVALUATOR_SUBMITTED_PERSON_ID = deterministicUuid("evaluator-demo:person:noor-haddad");
export const EVALUATOR_DRAFT_PERSON_ID = deterministicUuid("evaluator-demo:person:iris-cole");
export const EVALUATOR_MINA_SUBMISSION_ID = deterministicUuid("evaluator-demo:submission:mina-park");
export const EVALUATOR_NOOR_SUBMISSION_ID = deterministicUuid("evaluator-demo:submission:noor-haddad");
export const EVALUATOR_IRIS_SUBMISSION_ID = deterministicUuid("evaluator-demo:submission:iris-cole");

export const EVALUATOR_ARTIFACT_FIXTURE_MANIFEST = Object.freeze([
  Object.freeze({
    kind: "HEADSHOT" as const,
    mediaType: "image/png" as const,
    displayFilename: "headshot.png",
    byteSize: 569,
    sha256: "9727e98b19375716494cffa46f09edc60624d8a381199cc63a420a6c0f7174fc",
  }),
  Object.freeze({
    kind: "SLIDES" as const,
    mediaType: "application/pdf" as const,
    displayFilename: "slides.pdf",
    byteSize: 608,
    sha256: "a05e7a2b13c6f9d34de76c2d5a32b160faf7cd19537e3173833937ef652d66cb",
  }),
] as const);

const EVALUATOR_ARTIFACT_FIXTURE_BYTES = Object.freeze({
  HEADSHOT: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACAElEQVR42u3TQQ0AAAjEsFOHCDQhmjcaaFIFS5bqgbciAQYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABMIAKGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAbAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAGUAEDgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwAFwLUysRleTQrvsAAAAASUVORK5CYII=",
    "base64",
  ),
  SLIDES: Buffer.from(
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2NSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoRGV2RmxvdyBDb25mIDIwMjcgLSBTYW1wbGUgU2xpZGVzKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM1NSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQyNQolJUVPRgo=",
    "base64",
  ),
});

const SEEDED_AT = "2026-08-01T12:00:00.000Z";
const SEEDED_OPEN_AT = "2026-08-01T12:00:01.000Z";
const EVENT_STARTS_AT = "2026-09-18T09:00:00.000Z";
const EVENT_ENDS_AT = "2026-09-18T17:00:00.000Z";
const SESSION_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

const MINA_EMAIL = "mina.park@sympose.example";
const NOOR_EMAIL = "noor.haddad@sympose.example";
const IRIS_EMAIL = "iris.cole@sympose.example";
const REVIEWER_EMAIL = "reviewer@acme.example";

/** Exact seeded account tuples exposed by the local evaluator organizer/reviewer entry points. */
export const EVALUATOR_ORGANIZER_LOGIN_ACCOUNT_ALLOWLIST = Object.freeze([
  Object.freeze({
    accountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    workspaceId: EVALUATOR_WORKSPACE_ID,
    role: "organizer" as const,
    email: "organizer@acme.example",
  }),
] as const);

export const EVALUATOR_REVIEWER_LOGIN_ACCOUNT_ALLOWLIST = Object.freeze([
  Object.freeze({
    accountId: EVALUATOR_REVIEWER_ACCOUNT_ID,
    workspaceId: EVALUATOR_WORKSPACE_ID,
    role: "reviewer" as const,
    email: REVIEWER_EMAIL,
  }),
] as const);

const MINA_TITLE = "Evaluating AI systems without losing the plot";
const MINA_ABSTRACT =
  "A practical session on evaluation design, evidence quality, and making review decisions that remain understandable to the people who must act on them.";
const NOOR_TITLE = "Workshop: Evidence-first evaluation in the real world";
const NOOR_ABSTRACT =
  "A hands-on workshop for turning ambiguous evaluation goals into observable criteria, review notes, and decision-ready evidence.";
const NOOR_WORKSHOP_PLAN =
  "Participants bring one fuzzy evaluation goal, map it to observable evidence, and leave with a small review rubric they can test.";

const REVIEW_CRITERIA = Object.freeze([
  Object.freeze({
    semantic: "PROPOSAL_QUALITY" as const,
    kind: "numeric" as const,
    required: true,
    weight: 2,
    minimum: 1,
    maximum: 5,
    step: 1,
  }),
  Object.freeze({
    semantic: "AUDIENCE_RELEVANCE" as const,
    kind: "scale" as const,
    required: true,
    weight: 1,
    scaleCode: "LOW_MEDIUM_HIGH" as const,
  }),
  Object.freeze({
    semantic: "INDEPENDENT_RECOMMENDATION" as const,
    kind: "recommendation" as const,
    required: true,
    weight: 1,
  }),
  Object.freeze({
    semantic: "REVIEWER_NOTES" as const,
    kind: "comment" as const,
    required: false,
    weight: 1,
    maxLength: 2_000,
  }),
]);

const RUBRIC_DOCUMENT = {
  schema: "cfp-rubric/v1",
  title: "Independent proposal review",
  criteria: REVIEW_CRITERIA,
};

const SEEDED_PEOPLE = [
  {
    id: EVALUATOR_SPEAKER_PERSON_ID,
    email: MINA_EMAIL,
    fullName: "Mina Park",
    organization: "Signal Garden",
    title: "Evaluation Lead",
    expertise: ["evaluation", "evidence design"],
    moderatorEligible: true,
    sourceRef: "evaluator/demo/mina-park",
  },
  {
    id: EVALUATOR_SUBMITTED_PERSON_ID,
    email: NOOR_EMAIL,
    fullName: "Noor Haddad",
    organization: "Open Lantern",
    title: "Research Director",
    expertise: ["research", "workshops"],
    moderatorEligible: false,
    sourceRef: "evaluator/demo/noor-haddad",
  },
  {
    id: EVALUATOR_DRAFT_PERSON_ID,
    email: IRIS_EMAIL,
    fullName: "Iris Cole",
    organization: "Northwind Studio",
    title: "Product Researcher",
    expertise: ["product research", "facilitation"],
    moderatorEligible: false,
    sourceRef: "evaluator/demo/iris-cole",
  },
] as const;

function createEvaluatorPersistence() {
  return createCfpPersistence({
    clock: () => SEEDED_AT,
    idGenerator: (() => {
    const ids = [
      EVALUATOR_FORM_DEFINITION_ID,
      EVALUATOR_FORM_VERSION_ID,
      EVALUATOR_RULE_VERSION_ID,
      deterministicUuid("evaluator-demo:call-policy:acme"),
      EVALUATOR_CALL_ID,
      EVALUATOR_MINA_SUBMISSION_ID,
      deterministicUuid("evaluator-demo:revision:mina-park"),
      EVALUATOR_NOOR_SUBMISSION_ID,
      deterministicUuid("evaluator-demo:revision:noor-haddad"),
      EVALUATOR_IRIS_SUBMISSION_ID,
      deterministicUuid("evaluator-demo:revision:iris-cole"),
    ];
    let index = 0;
    return () => ids[index++] ?? deterministicUuid(`evaluator-demo:generated:${index++}`);
    })(),
  });
}

function evaluatorSeedIsComplete(db: Db): boolean {
  const evidence = db
    .prepare(
      `SELECT
         event.current_plan_version_id AS planVersionId,
         event.current_release_id AS releaseId,
         EXISTS (
           SELECT 1 FROM calls
           WHERE workspace_id = event.workspace_id AND id = ?
         ) AS hasCall,
         (SELECT COUNT(*) FROM submissions
          WHERE workspace_id = event.workspace_id AND id IN (?, ?, ?)) AS seededSubmissionCount,
         EXISTS (
           SELECT 1 FROM review_assignments
           WHERE workspace_id = event.workspace_id AND id = ?
         ) AS hasAssignment,
         EXISTS (
           SELECT 1 FROM review_rubric_semantics
           WHERE workspace_id = event.workspace_id AND round_id = ?
         ) AS hasRubric,
         EXISTS (
           SELECT 1 FROM review_blind_artifacts
           WHERE workspace_id = event.workspace_id AND assignment_id = ?
         ) AS hasBlindArtifact,
         EXISTS (
           SELECT 1 FROM publication_releases release
           WHERE release.workspace_id = event.workspace_id
             AND release.event_id = event.id
             AND release.id = event.current_release_id
             AND release.plan_version_id = event.current_plan_version_id
         ) AS hasCurrentRelease
       FROM events event
       WHERE event.workspace_id = ? AND event.id = ?`,
    )
    .get(
      EVALUATOR_CALL_ID,
      EVALUATOR_MINA_SUBMISSION_ID,
      EVALUATOR_NOOR_SUBMISSION_ID,
      EVALUATOR_IRIS_SUBMISSION_ID,
      EVALUATOR_ASSIGNMENT_ID,
      EVALUATOR_ROUND_ID,
      EVALUATOR_ASSIGNMENT_ID,
      EVALUATOR_WORKSPACE_ID,
      EVALUATOR_EVENT_ID,
    ) as
    | {
        planVersionId: string | null;
        releaseId: string | null;
        hasCall: number;
        seededSubmissionCount: number;
        hasAssignment: number;
        hasRubric: number;
        hasBlindArtifact: number;
        hasCurrentRelease: number;
      }
    | undefined;
  return (
    evidence?.planVersionId !== null &&
    evidence?.planVersionId !== undefined &&
    evidence.releaseId !== null &&
    evidence.releaseId !== undefined &&
    evidence.hasCall === 1 &&
    evidence.seededSubmissionCount === 3 &&
    evidence.hasAssignment === 1 &&
    evidence.hasRubric === 1 &&
    evidence.hasBlindArtifact === 1 &&
    evidence.hasCurrentRelease === 1
  );
}

function ensureEvaluatorSpeakerProvenance(db: Db): void {
  const id = deterministicUuid(`evaluator-demo:event-speaker:${EVALUATOR_SPEAKER_PERSON_ID}`);
  const assignmentRows = db
    .prepare(
      `SELECT assignment.assignment_type AS assignmentRole, offer.terms_json AS termsJson
       FROM events event_row
       JOIN plan_versions plan
         ON plan.id = event_row.current_plan_version_id
        AND plan.workspace_id = event_row.workspace_id
        AND plan.event_id = event_row.id
       JOIN plan_assignments assignment
         ON assignment.workspace_id = plan.workspace_id
        AND assignment.plan_version_id = plan.id
        AND assignment.person_id = ?
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
       WHERE event_row.workspace_id = ? AND event_row.id = ?
         AND json_extract(offer.terms_json, '$.planVersionId') = plan.id
         AND json_extract(offer.terms_json, '$.eventId') = event_row.id
         AND json_extract(offer.terms_json, '$.programUnitId') = assignment.program_unit_id
       GROUP BY assignment.id
       HAVING COUNT(DISTINCT offer.id) = 1 AND COUNT(DISTINCT response.id) = 1
       ORDER BY assignment.id
       LIMIT 2`,
    )
    .all(EVALUATOR_SPEAKER_PERSON_ID, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as unknown as readonly {
      assignmentRole: unknown;
      termsJson: unknown;
    }[];
  if (assignmentRows.length !== 1) {
    throw new Error("EVALUATOR_DEMO_SPEAKER_AUTHORITY_INVALID");
  }
  const normalizeRole = (value: unknown): "SPEAKER" | "MODERATOR" | null => {
    if (value === "SPEAKER" || value === "participant") return "SPEAKER";
    if (value === "MODERATOR" || value === "moderator") return "MODERATOR";
    return null;
  };
  let offerRole: unknown;
  try {
    offerRole = JSON.parse(
      typeof assignmentRows[0]?.termsJson === "string" ? assignmentRows[0].termsJson : "",
    ).role;
  } catch {
    throw new Error("EVALUATOR_DEMO_SPEAKER_AUTHORITY_INVALID");
  }
  const role = normalizeRole(assignmentRows[0]?.assignmentRole);
  if (role === null || normalizeRole(offerRole) !== role) {
    throw new Error("EVALUATOR_DEMO_SPEAKER_AUTHORITY_INVALID");
  }
  const existing = db
    .prepare(
      `SELECT id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at
       FROM event_speakers WHERE id = ? AND workspace_id = ?`,
    )
    .get(id, EVALUATOR_WORKSPACE_ID) as
    | {
        id: string;
        workspace_id: string;
        event_id: string;
        person_id: string;
        role_key: string;
        participation_status: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO event_speakers
         (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?)`,
    ).run(id, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_SPEAKER_PERSON_ID, role, SEEDED_AT, SEEDED_AT);
    return;
  }
  if (
    existing.id !== id ||
    existing.workspace_id !== EVALUATOR_WORKSPACE_ID ||
    existing.event_id !== EVALUATOR_EVENT_ID ||
    existing.person_id !== EVALUATOR_SPEAKER_PERSON_ID ||
    existing.role_key !== role ||
    existing.participation_status !== "CONFIRMED" ||
    existing.created_at !== SEEDED_AT ||
    existing.updated_at !== SEEDED_AT
  ) {
    throw new Error("EVALUATOR_DEMO_SPEAKER_PROVENANCE_INVALID");
  }
}

export function seedEvaluatorSpeakerTaskFixtures(db: Db): void {
  const assignments = db
    .prepare(
      `SELECT assignment.id
       FROM events event_row
       JOIN plan_versions plan ON plan.id = event_row.current_plan_version_id
        AND plan.workspace_id = event_row.workspace_id AND plan.event_id = event_row.id
       JOIN plan_assignments assignment ON assignment.plan_version_id = plan.id
        AND assignment.workspace_id = plan.workspace_id AND assignment.person_id = ?
       WHERE event_row.workspace_id = ? AND event_row.id = ?
       ORDER BY assignment.id
       LIMIT 2`,
    )
    .all(
      EVALUATOR_SPEAKER_PERSON_ID,
      EVALUATOR_WORKSPACE_ID,
      EVALUATOR_EVENT_ID,
    ) as Array<{ id: string }>;
  if (assignments.length !== 1 || typeof assignments[0]?.id !== "string") {
    throw new Error("EVALUATOR_DEMO_SPEAKER_ASSIGNMENT_INVALID");
  }
  const assignmentId = assignments[0].id;
  const definitions = [
    {
      kind: "HEADSHOT",
      title: "Headshot PNG",
      required: 1,
      gate: "PUBLICATION",
      dueAt: "2026-08-25T17:00:00.000Z",
    },
    {
      kind: "SLIDES",
      title: "Slides or supporting PDF",
      required: 0,
      gate: "OPERATOR_RELEASE",
      dueAt: "2026-09-10T17:00:00.000Z",
    },
  ] as const;
  for (const definition of definitions) {
    const id = deterministicUuid(
      `speaker-task:${EVALUATOR_SPEAKER_PERSON_ID}:${assignmentId}:${definition.kind}`,
    );
    const existing = db
      .prepare(
        `SELECT id, workspace_id, event_id, person_id, assignment_id, task_kind,
                content_kind, title, required, gate, owner, due_at, created_at
         FROM speaker_tasks WHERE id = ? AND workspace_id = ?`,
      )
      .get(id, EVALUATOR_WORKSPACE_ID) as Record<string, unknown> | undefined;
    const expected = {
      id,
      workspace_id: EVALUATOR_WORKSPACE_ID,
      event_id: EVALUATOR_EVENT_ID,
      person_id: EVALUATOR_SPEAKER_PERSON_ID,
      assignment_id: assignmentId,
      task_kind: definition.kind,
      content_kind: definition.kind,
      title: definition.title,
      required: definition.required,
      gate: definition.gate,
      owner: "SPEAKER",
      due_at: definition.dueAt,
      created_at: SEEDED_AT,
    };
    if (!existing) {
      db.prepare(
        `INSERT INTO speaker_tasks
           (id, workspace_id, event_id, person_id, assignment_id, task_kind, content_kind,
            title, required, gate, owner, state, due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SPEAKER', 'NOT_STARTED', ?, ?, ?)`,
      ).run(
        id,
        EVALUATOR_WORKSPACE_ID,
        EVALUATOR_EVENT_ID,
        EVALUATOR_SPEAKER_PERSON_ID,
        assignmentId,
        definition.kind,
        definition.kind,
        definition.title,
        definition.required,
        definition.gate,
        definition.dueAt,
        SEEDED_AT,
        SEEDED_AT,
      );
      continue;
    }
    if (JSON.stringify(existing) !== JSON.stringify(expected)) {
      throw new Error("EVALUATOR_DEMO_SPEAKER_TASK_INVALID");
    }
  }
}

function assertLocalEvaluatorProfile(): void {
  if (
    process.env.SYMPOSE_EVALUATOR_PROFILE !== "local" ||
    (process.env.NODE_ENV === "production" && process.env.SYMPOSE_PUBLIC_SYNTHETIC_DEMO !== "1")
  ) {
    throw new Error("EVALUATOR_ARTIFACT_FIXTURE_PROFILE_DENIED");
  }
}

function invalidEvaluatorArtifactFixture(): never {
  throw new Error("EVALUATOR_ARTIFACT_FIXTURE_INVALID");
}

function assertEvaluatorPdfFixtureStructure(bytes: Uint8Array): void {
  const source = Buffer.from(bytes);
  const text = source.toString("latin1");
  if (!text.startsWith("%PDF-1.4\n") || !text.endsWith("%%EOF\n")) {
    invalidEvaluatorArtifactFixture();
  }

  const xrefOffsetMatch = /startxref\n([0-9]+)\n%%EOF\n$/u.exec(text);
  if (!xrefOffsetMatch) invalidEvaluatorArtifactFixture();
  const xrefOffset = Number(xrefOffsetMatch[1]);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 1 || text.slice(xrefOffset, xrefOffset + 5) !== "xref\n") {
    invalidEvaluatorArtifactFixture();
  }

  const trailerOffset = text.indexOf("trailer\n", xrefOffset);
  if (trailerOffset <= xrefOffset) invalidEvaluatorArtifactFixture();
  const xrefLines = text.slice(xrefOffset, trailerOffset).split("\n");
  const subsection = /^0 ([0-9]+)$/u.exec(xrefLines[1] ?? "");
  if (xrefLines[0] !== "xref" || !subsection || xrefLines.at(-1) !== "") invalidEvaluatorArtifactFixture();
  const objectCount = Number(subsection[1]);
  if (!Number.isSafeInteger(objectCount) || objectCount < 2 || xrefLines.length !== objectCount + 3) {
    invalidEvaluatorArtifactFixture();
  }

  const objectOffsets = new Map<number, number>();
  for (const [index, line] of xrefLines.slice(2, -1).entries()) {
    const entry = /^(\d{10}) (\d{5}) ([fn]) $/u.exec(line);
    if (!entry) invalidEvaluatorArtifactFixture();
    const offset = Number(entry[1]);
    const generation = Number(entry[2]);
    const state = entry[3];
    if (!Number.isSafeInteger(offset) || offset >= xrefOffset) invalidEvaluatorArtifactFixture();
    if (index === 0) {
      if (offset !== 0 || generation !== 65535 || state !== "f") invalidEvaluatorArtifactFixture();
    } else {
      if (generation !== 0 || state !== "n") invalidEvaluatorArtifactFixture();
      objectOffsets.set(index, offset);
    }
  }

  const trailer = new RegExp(
    `^trailer\\n<< /Size (${objectCount}) /Root (\\d+) 0 R >>\\nstartxref\\n${xrefOffset}\\n%%EOF\\n$`,
    "u",
  ).exec(text.slice(trailerOffset));
  if (!trailer || Number(trailer[1]) !== objectCount || Number(trailer[2]) !== 1) {
    invalidEvaluatorArtifactFixture();
  }

  const objectBodies = new Map<number, Buffer>();
  const endObjectMarker = Buffer.from("\nendobj\n", "ascii");
  for (let objectId = 1; objectId < objectCount; objectId += 1) {
    const offset = objectOffsets.get(objectId);
    const nextOffset = objectId + 1 < objectCount ? objectOffsets.get(objectId + 1) : xrefOffset;
    if (offset === undefined || nextOffset === undefined || offset < 1 || nextOffset <= offset) {
      invalidEvaluatorArtifactFixture();
    }
    const header = Buffer.from(`${objectId} 0 obj\n`, "ascii");
    if (!source.subarray(offset, offset + header.length).equals(header)) invalidEvaluatorArtifactFixture();
    const body = source.subarray(offset, nextOffset);
    const endObject = body.indexOf(endObjectMarker, header.length);
    if (endObject < 0 || endObject + endObjectMarker.length !== body.length) invalidEvaluatorArtifactFixture();
    objectBodies.set(objectId, body);
  }

  const streamObject = objectBodies.get(4);
  if (!streamObject) invalidEvaluatorArtifactFixture();
  const streamText = streamObject.toString("latin1");
  const streamHeader = /^4 0 obj\n<< \/Length ([0-9]+) >>\nstream\n/u.exec(streamText);
  if (!streamHeader) invalidEvaluatorArtifactFixture();
  const declaredLength = Number(streamHeader[1]);
  const streamMarker = Buffer.from("stream\n", "ascii");
  const streamStart = streamObject.indexOf(streamMarker);
  const endStreamMarker = Buffer.from("\nendstream\n", "ascii");
  const endStream = streamObject.indexOf(endStreamMarker, streamStart + streamMarker.length);
  if (
    !Number.isSafeInteger(declaredLength) ||
    streamStart < 0 ||
    streamStart + streamMarker.length !== Buffer.byteLength(streamHeader[0], "latin1") ||
    endStream < 0 ||
    !streamObject.subarray(endStream + endStreamMarker.length).equals(Buffer.from("endobj\n", "ascii"))
  ) {
    invalidEvaluatorArtifactFixture();
  }
  const streamPayload = streamObject.subarray(streamStart + streamMarker.length, endStream + 1);
  if (streamPayload.length !== declaredLength) invalidEvaluatorArtifactFixture();
}

function evaluatorArtifactTaskId(kind: "HEADSHOT" | "SLIDES"): string {
  return deterministicUuid(
    `speaker-task:${EVALUATOR_SPEAKER_PERSON_ID}:${EVALUATOR_ASSIGNMENT_ID}:${kind}`,
  );
}

function assertNoUnrelatedPreparedArtifactIntents(db: Db): void {
  const owned = new Set(
    EVALUATOR_ARTIFACT_FIXTURE_MANIFEST.map((fixture) => JSON.stringify([
      EVALUATOR_WORKSPACE_ID,
      EVALUATOR_EVENT_ID,
      EVALUATOR_SPEAKER_PERSON_ID,
      evaluatorArtifactTaskId(fixture.kind),
      fixture.kind,
    ])),
  );
  const prepared = db
    .prepare(
      `SELECT workspace_id, event_id, person_id, task_id, kind
       FROM artifact_upload_intents
       WHERE workspace_id = ? AND event_id = ? AND status = 'PREPARED'`,
    )
    .all(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as unknown as ReadonlyArray<{
      workspace_id: unknown;
      event_id: unknown;
      person_id: unknown;
      task_id: unknown;
      kind: unknown;
    }>;
  if (
    prepared.some((intent) => !owned.has(JSON.stringify([
      intent.workspace_id,
      intent.event_id,
      intent.person_id,
      intent.task_id,
      intent.kind,
    ])))
  ) {
    throw new Error("EVALUATOR_ARTIFACT_FIXTURE_SCOPE_INVALID");
  }
}

function verifyEvaluatorArtifactFixture(
  db: Db,
  taskId: string,
  fixture: (typeof EVALUATOR_ARTIFACT_FIXTURE_MANIFEST)[number],
  options?: ArtifactRecordServiceOptions,
): SpeakerArtifactRecord {
  const scope = {
    workspaceId: EVALUATOR_WORKSPACE_ID,
    eventId: EVALUATOR_EVENT_ID,
    personId: EVALUATOR_SPEAKER_PERSON_ID,
    taskId,
    kind: fixture.kind,
  };
  const records = listSpeakerArtifactRecords(db, scope, options);
  const baseline = records.filter((record) => record.version === 1);
  if (baseline.length !== 1) {
    throw new Error("EVALUATOR_ARTIFACT_FIXTURE_INVALID");
  }
  const record = baseline[0]!;
  const stored = readSpeakerArtifact(db, scope, record.artifactId, options);
  const expectedBytes = EVALUATOR_ARTIFACT_FIXTURE_BYTES[fixture.kind];
  if (
    record.workspaceId !== scope.workspaceId ||
    record.eventId !== scope.eventId ||
    record.personId !== scope.personId ||
    record.taskId !== scope.taskId ||
    record.kind !== fixture.kind ||
    record.version !== 1 ||
    record.supersedesRecordId !== null ||
    record.storageProvider !== "local" ||
    record.mediaType !== fixture.mediaType ||
    record.displayFilename !== fixture.displayFilename ||
    record.byteSize !== fixture.byteSize ||
    record.sha256 !== fixture.sha256 ||
    stored === null ||
    stored.record.artifactId !== record.artifactId ||
    stored.bytes.byteLength !== fixture.byteSize ||
    createHash("sha256").update(stored.bytes).digest("hex") !== fixture.sha256 ||
    !stored.bytes.equals(expectedBytes)
  ) {
    throw new Error("EVALUATOR_ARTIFACT_FIXTURE_INVALID");
  }
  return record;
}

/**
 * Persist real, bounded evaluator files through the ordinary artifact/version boundary.
 * Existing baseline versions are verified byte-for-byte; later speaker uploads remain untouched.
 */
export function seedEvaluatorArtifactFixtures(
  db: Db,
  options?: ArtifactRecordServiceOptions,
): readonly SpeakerArtifactRecord[] {
  assertLocalEvaluatorProfile();
  if (db.isTransaction) {
    throw new Error("EVALUATOR_ARTIFACT_FIXTURE_TRANSACTION_UNSAFE");
  }
  assertNoUnrelatedPreparedArtifactIntents(db);
  for (const fixture of EVALUATOR_ARTIFACT_FIXTURE_MANIFEST) {
    const bytes = EVALUATOR_ARTIFACT_FIXTURE_BYTES[fixture.kind];
    if (
      bytes.byteLength !== fixture.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== fixture.sha256
    ) {
      invalidEvaluatorArtifactFixture();
    }
    if (fixture.kind === "SLIDES") assertEvaluatorPdfFixtureStructure(bytes);
  }

  let tasks: ReadonlyArray<Record<string, unknown>> = [];
  withTransactionOrSavepoint(db, "evaluator_artifact_fixture_scope", () => {
    ensureEvaluatorSpeakerProvenance(db);
    seedEvaluatorSpeakerTaskFixtures(db);
    tasks = db
      .prepare(
        `SELECT id, workspace_id, event_id, person_id, assignment_id, task_kind,
                content_kind, owner
         FROM speaker_tasks
         WHERE workspace_id = ? AND event_id = ? AND person_id = ?
           AND task_kind IN ('HEADSHOT', 'SLIDES')
         ORDER BY task_kind`,
      )
      .all(
        EVALUATOR_WORKSPACE_ID,
        EVALUATOR_EVENT_ID,
        EVALUATOR_SPEAKER_PERSON_ID,
      ) as unknown as ReadonlyArray<Record<string, unknown>>;
    assertNoUnrelatedPreparedArtifactIntents(db);
  });
  if (
    tasks.length !== EVALUATOR_ARTIFACT_FIXTURE_MANIFEST.length ||
    new Set(tasks.map((task) => task.assignment_id)).size !== 1
  ) {
    throw new Error("EVALUATOR_ARTIFACT_FIXTURE_SCOPE_INVALID");
  }

  const seeded: SpeakerArtifactRecord[] = [];
  for (const fixture of EVALUATOR_ARTIFACT_FIXTURE_MANIFEST) {
    const task = tasks.find((candidate) => candidate.task_kind === fixture.kind);
    if (
      !task ||
      typeof task.id !== "string" ||
      typeof task.assignment_id !== "string" ||
      task.assignment_id.length === 0 ||
      task.workspace_id !== EVALUATOR_WORKSPACE_ID ||
      task.event_id !== EVALUATOR_EVENT_ID ||
      task.person_id !== EVALUATOR_SPEAKER_PERSON_ID ||
      task.content_kind !== fixture.kind ||
      task.owner !== "SPEAKER"
    ) {
      throw new Error("EVALUATOR_ARTIFACT_FIXTURE_SCOPE_INVALID");
    }
    const scope = {
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: EVALUATOR_SPEAKER_PERSON_ID,
      taskId: task.id,
      kind: fixture.kind,
    };
    assertNoUnrelatedPreparedArtifactIntents(db);
    const existing = listSpeakerArtifactRecords(db, scope, options);
    if (existing.length === 0) {
      const bytes = EVALUATOR_ARTIFACT_FIXTURE_BYTES[fixture.kind];
      if (
        bytes.byteLength !== fixture.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== fixture.sha256
      ) {
        throw new Error("EVALUATOR_ARTIFACT_FIXTURE_INVALID");
      }
      try {
        createSpeakerArtifactRecord(
          db,
          scope,
          {
            bytes,
            mediaType: fixture.mediaType,
            originalFilename: fixture.displayFilename,
          },
          options,
        );
      } catch (error) {
        if (error instanceof Error && error.name === "ArtifactRecordCrashInjectedError") {
          throw error;
        }
        assertNoUnrelatedPreparedArtifactIntents(db);
        const concurrent = listSpeakerArtifactRecords(db, scope, options);
        if (concurrent.filter((record) => record.version === 1).length !== 1) {
          throw error;
        }
      }
    }
    seeded.push(verifyEvaluatorArtifactFixture(db, task.id, fixture, options));
  }
  return Object.freeze(seeded);
}

/** Approve only the byte-verified, deterministic v1 evaluator artifact required for publication. */
function approveEvaluatorPublicationArtifactFixtures(
  db: Db,
  records: readonly SpeakerArtifactRecord[],
): void {
  assertLocalEvaluatorProfile();
  const required = db.prepare(
    `SELECT task.assignment_id AS assignmentId, task.id AS taskId, task.task_kind AS kind,
            artifact.id AS artifactId, artifact.content_version_id AS contentVersionId,
            artifact.version, version.content_hash AS contentHash
       FROM speaker_tasks task
       JOIN artifact_records artifact
         ON artifact.workspace_id = task.workspace_id
        AND artifact.event_id = task.event_id
        AND artifact.person_id = task.person_id
        AND artifact.task_id = task.id
        AND artifact.kind = task.task_kind
       JOIN speaker_content_versions version
         ON version.id = artifact.content_version_id
        AND version.workspace_id = artifact.workspace_id
        AND version.event_id = artifact.event_id
        AND version.person_id = artifact.person_id
        AND version.task_id = artifact.task_id
        AND version.kind = artifact.kind
        AND version.version = artifact.version
      WHERE task.workspace_id = ? AND task.event_id = ? AND task.person_id = ?
        AND task.required = 1 AND task.gate = 'PUBLICATION' AND task.owner = 'SPEAKER'
        AND task.task_kind = task.content_kind AND task.task_kind IN ('HEADSHOT', 'SLIDES')
      ORDER BY task.assignment_id, task.id, artifact.version`,
  ).all(
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_EVENT_ID,
    EVALUATOR_SPEAKER_PERSON_ID,
  ) as unknown as readonly {
    readonly assignmentId: string;
    readonly taskId: string;
    readonly kind: "HEADSHOT" | "SLIDES";
    readonly artifactId: string;
    readonly contentVersionId: string;
    readonly version: number;
    readonly contentHash: string;
  }[];
  if (required.length !== 1 || required[0]?.kind !== "HEADSHOT") {
    throw new Error("EVALUATOR_ARTIFACT_FIXTURE_APPROVAL_INVALID");
  }
  for (const row of required) {
    const record = records.find((candidate) => candidate.artifactId === row.artifactId);
    const fixture = EVALUATOR_ARTIFACT_FIXTURE_MANIFEST.find((candidate) => candidate.kind === row.kind);
    if (
      !record?.current || !fixture || row.assignmentId.length === 0 ||
      row.taskId !== record.taskId || row.version !== 1 || record.version !== 1 ||
      row.kind !== record.kind || row.contentHash.length !== 64 ||
      record.sha256 !== fixture.sha256 || record.mediaType !== fixture.mediaType ||
      record.byteSize !== fixture.byteSize || record.displayFilename !== fixture.displayFilename
    ) {
      throw new Error("EVALUATOR_ARTIFACT_FIXTURE_APPROVAL_INVALID");
    }
    const speaker = createSyntheticSpeakerOperationsRepository({ db, clock: () => record.createdAt });
    const approval = speaker.approveContent({
      kind: "organizer",
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    }, {
      personId: EVALUATOR_SPEAKER_PERSON_ID,
      taskId: row.taskId,
      submissionVersionId: row.contentVersionId,
      submissionContentHash: row.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: `evaluator-demo-${row.kind.toLowerCase()}-v1-publication-approval`,
    });
    if (
      approval.personId !== EVALUATOR_SPEAKER_PERSON_ID || approval.taskId !== row.taskId ||
      approval.submissionVersionId !== row.contentVersionId ||
      approval.submissionContentHash !== row.contentHash ||
      approval.approvedBy !== EVALUATOR_ORGANIZER_ACCOUNT_ID ||
      approval.approvedAt !== record.createdAt || approval.gate !== "PUBLICATION"
    ) {
      throw new Error("EVALUATOR_ARTIFACT_FIXTURE_APPROVAL_INVALID");
    }
  }
}

function ensureEvaluatorSessionContent(db: Db): void {
  const speaker = createSyntheticSpeakerOperationsRepository({ db, clock: () => SEEDED_AT });
  const scope = {
    kind: "organizer" as const,
    workspaceId: EVALUATOR_WORKSPACE_ID,
    eventId: EVALUATOR_EVENT_ID,
    actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
  };
  const titleTask = speaker.createTask(scope, {
    personId: EVALUATOR_SPEAKER_PERSON_ID,
    kind: "SESSION_TITLE",
    contentKind: "SESSION_TITLE",
    title: "Session title",
    description: "The exact audience-facing title for the evaluator program.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2026-08-25T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: "evaluator-demo-session-title-task",
  });
  const abstractTask = speaker.createTask(scope, {
    personId: EVALUATOR_SPEAKER_PERSON_ID,
    kind: "SESSION_DESCRIPTION",
    contentKind: "SESSION_DESCRIPTION",
    title: "Session description",
    description: "The exact audience-facing abstract for the evaluator program.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2026-08-25T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: "evaluator-demo-session-description-task",
  });
  const title = speaker.submitOrganizerContent(scope, {
    personId: EVALUATOR_SPEAKER_PERSON_ID,
    taskId: titleTask.id,
    payload: { kind: "SESSION_TITLE", title: MINA_TITLE },
    idempotencyKey: "evaluator-demo-session-title-version",
  });
  const abstract = speaker.submitOrganizerContent(scope, {
    personId: EVALUATOR_SPEAKER_PERSON_ID,
    taskId: abstractTask.id,
    payload: { kind: "SESSION_DESCRIPTION", description: MINA_ABSTRACT },
    idempotencyKey: "evaluator-demo-session-description-version",
  });
  speaker.approveContent(scope, {
    personId: EVALUATOR_SPEAKER_PERSON_ID,
    taskId: titleTask.id,
    submissionVersionId: title.id,
    submissionContentHash: title.contentHash,
    gate: "PUBLICATION",
    idempotencyKey: "evaluator-demo-session-title-approval",
  });
  speaker.approveContent(scope, {
    personId: EVALUATOR_SPEAKER_PERSON_ID,
    taskId: abstractTask.id,
    submissionVersionId: abstract.id,
    submissionContentHash: abstract.contentHash,
    gate: "PUBLICATION",
    idempotencyKey: "evaluator-demo-session-description-approval",
  });
}

function ensureEvaluatorSchedule(db: Db): void {
  db.prepare(
    `INSERT INTO event_rooms (id, workspace_id, event_id, name, capacity, created_at)
     VALUES ('room-default', ?, ?, 'Seed room', 100, ?)`,
  ).run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, SEEDED_AT);
  db.prepare(
    `INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at)
     VALUES ('track-default', ?, ?, 'Seed track', 'track-default', ?)`,
  ).run(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, SEEDED_AT);
  db.prepare(
    `INSERT INTO event_session_allocations
       (id, workspace_id, event_id, program_unit_id, room_id, track_id,
        starts_at, ends_at, allocation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'room-default', 'track-default', ?, ?, 'DRAFT', ?, ?)`,
  ).run(
    deterministicUuid("evaluator-demo:allocation:acme"),
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_EVENT_ID,
    EVALUATOR_PROGRAM_UNIT_ID,
    "2026-09-18T10:00:00.000Z",
    "2026-09-18T10:45:00.000Z",
    SEEDED_AT,
    SEEDED_AT,
  );
}

function ensureEvaluatorScheduleApproval(db: Db): void {
  const scope = { workspaceId: EVALUATOR_WORKSPACE_ID, eventId: EVALUATOR_EVENT_ID };
  let current = readScheduleDraft(db, scope);
  if (!current.persisted) {
    executeScheduleDraftCommand(db, scope, {
      expectedRevision: current.schedule.revision,
      planVersionId: current.schedule.planVersionId,
      planFingerprint: current.schedule.planFingerprint,
      acceptedInventoryFingerprint: current.schedule.acceptedInventoryFingerprint,
      cfpSessionInventoryFingerprint: current.schedule.cfpSessionInventoryFingerprint,
      command: { kind: "AUTO_PLACE", reason: "Materialize the seeded evaluator schedule" },
      idempotencyKey: "evaluator-demo-schedule-materialization-v1",
      requestId: "evaluator-demo-schedule-materialization-request-v1",
      actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    current = readScheduleDraft(db, scope);
  }
  if (readCurrentScheduleApproval(db, scope)) return;
  if (!current.pointer) throw new Error("EVALUATOR_SCHEDULE_POINTER_UNAVAILABLE");
  approveScheduleDraft(db, scope, {
    expectedRevision: current.schedule.revision,
    expectedScheduleAuthorityFingerprint: fingerprintOf(scheduleApprovalSubject(current.pointer)),
    idempotencyKey: "evaluator-demo-schedule-approval-v1",
    requestId: "evaluator-demo-schedule-approval-request-v1",
    actorAccountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
  });
}

function insertEvaluatorRoots(db: Db): void {
  const insertAccount = db.prepare(
    `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertAccount.run(
    EVALUATOR_REVIEWER_ACCOUNT_ID,
    EVALUATOR_WORKSPACE_ID,
    REVIEWER_EMAIL,
    "Acme Demo Reviewer",
    "reviewer",
    SEEDED_AT,
  );

  const insertPerson = db.prepare(
    `INSERT INTO people
       (id, workspace_id, canonical_email, full_name, organization, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSource = db.prepare(
    `INSERT INTO source_records
       (id, workspace_id, provider, source_ref, version, payload_json, imported_at)
     VALUES (?, ?, 'evaluator-demo', ?, 1, ?, ?)`,
  );
  const insertLink = db.prepare(
    `INSERT INTO source_links
       (id, workspace_id, person_id, source_record_id, link_decision, created_at)
     VALUES (?, ?, ?, ?, 'matched', ?)`,
  );

  for (const person of SEEDED_PEOPLE) {
    insertPerson.run(
      person.id,
      EVALUATOR_WORKSPACE_ID,
      person.email,
      person.fullName,
      person.organization,
      person.title,
      SEEDED_AT,
    );
    const sourceRecordId = deterministicUuid(`evaluator-demo:source-record:${person.id}`);
    insertSource.run(
      sourceRecordId,
      EVALUATOR_WORKSPACE_ID,
      person.sourceRef,
      canonicalJson({
        schema: "evaluator-demo-source/v1",
        record: {
          email: person.email,
          fullName: person.fullName,
          organization: person.organization,
          title: person.title,
          expertise: person.expertise,
          moderatorEligible: person.moderatorEligible,
        },
      }),
      SEEDED_AT,
    );
    insertLink.run(
      deterministicUuid(`evaluator-demo:source-link:${person.id}`),
      EVALUATOR_WORKSPACE_ID,
      person.id,
      sourceRecordId,
      SEEDED_AT,
    );
  }

  db.prepare(
    `INSERT INTO events
       (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
  ).run(
    EVALUATOR_EVENT_ID,
    EVALUATOR_WORKSPACE_ID,
    "Acme Evaluator Summit",
    EVENT_STARTS_AT,
    EVENT_ENDS_AT,
    SEEDED_AT,
  );
  db.prepare(
    `INSERT INTO program_units
       (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
     VALUES (?, ?, ?, ?, 'session', ?, ?, 80, ?)`,
  ).run(
    EVALUATOR_PROGRAM_UNIT_ID,
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_EVENT_ID,
    "Trustworthy Evaluation Keynote",
    "2026-09-18T10:00:00.000Z",
    "2026-09-18T10:45:00.000Z",
    SEEDED_AT,
  );

  const cohortDefinitionId = deterministicUuid("evaluator-demo:cohort-definition:acme");
  const snapshotId = deterministicUuid("evaluator-demo:cohort-snapshot:acme");
  const snapshotMembers = [
    {
      personId: EVALUATOR_SPEAKER_PERSON_ID,
      rank: 1,
      whyIn: "Accepted speaker fixture selected for the seeded keynote session.",
    },
  ];
  const snapshotFingerprint = fingerprintOf({
    schema: "cohort-snapshot/v1",
    workspaceId: EVALUATOR_WORKSPACE_ID,
    cohortName: "Accepted speaker demo cohort",
    definitionVersion: 1,
    asOf: SEEDED_AT,
    members: snapshotMembers,
  });
  db.prepare(
    `INSERT INTO cohort_definitions
       (id, workspace_id, name, version, definition_json, created_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(
    cohortDefinitionId,
    EVALUATOR_WORKSPACE_ID,
    "Accepted speaker demo cohort",
    canonicalJson({
      name: "Accepted speaker demo cohort",
      version: 1,
      purpose: "seed one accepted speaker/session path for evaluation",
      asOf: SEEDED_AT,
    }),
    SEEDED_AT,
  );
  db.prepare(
    `INSERT INTO cohort_snapshots
       (id, workspace_id, cohort_definition_id, definition_version, as_of, fingerprint, member_count, created_at)
     VALUES (?, ?, ?, 1, ?, ?, 1, ?)`,
  ).run(
    snapshotId,
    EVALUATOR_WORKSPACE_ID,
    cohortDefinitionId,
    SEEDED_AT,
    snapshotFingerprint,
    SEEDED_AT,
  );
  db.prepare(
    `INSERT INTO cohort_snapshot_members
       (id, workspace_id, snapshot_id, person_id, rank, why_in)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    deterministicUuid("evaluator-demo:cohort-member:mina-park"),
    EVALUATOR_WORKSPACE_ID,
    snapshotId,
    EVALUATOR_SPEAKER_PERSON_ID,
    1,
    snapshotMembers[0]!.whyIn,
  );
}

function insertApplicantAccess(db: Db, personId: string, email: string, suffix: string): string {
  const verificationId = deterministicUuid(`evaluator-demo:verification:${suffix}`);
  const applicantSessionId = deterministicUuid(`evaluator-demo:applicant-session:${suffix}`);
  const tokenHash = sha256Hex(`evaluator-demo-applicant-session:${suffix}`);
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verificationId,
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_CALL_ID,
    email,
    tokenHash,
    SESSION_EXPIRES_AT,
    SEEDED_AT,
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    deterministicUuid(`evaluator-demo:verification-consumption:${suffix}`),
    EVALUATOR_WORKSPACE_ID,
    verificationId,
    personId,
    SEEDED_AT,
  );
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    applicantSessionId,
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_CALL_ID,
    personId,
    verificationId,
    tokenHash,
    SEEDED_AT,
    SESSION_EXPIRES_AT,
  );
  return tokenHash;
}

function seedCfp(db: Db): {
  readonly submittedRevisionId: string;
  readonly submittedRevisionFingerprint: string;
} {
  const formPersistence = createEvaluatorPersistence();
  const organizer = {
    workspaceId: EVALUATOR_WORKSPACE_ID,
    accountId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
  };
  const formDefinition = formPersistence.createFormDefinition(db, organizer, {
    name: "Stagecraft 2026 proposal form",
  });
  const formVersion = formPersistence.sealFormVersion(db, organizer, {
    formDefinitionId: formDefinition.id,
    fields: [
      {
        id: "title",
        type: "shortText",
        label: "Session title",
        required: true,
        defaultVisibility: "visible",
      },
      {
        id: "track",
        type: "singleChoice",
        label: "Track",
        required: true,
        defaultVisibility: "visible",
        config: {
          options: [
            { value: "Main stage", label: "Main stage" },
            { value: "Practice rooms", label: "Practice rooms" },
          ],
        },
      },
      {
        id: "format",
        type: "singleChoice",
        label: "Format",
        required: true,
        defaultVisibility: "visible",
        config: {
          options: [
            { value: "Talk", label: "Talk" },
            { value: "Workshop", label: "Workshop" },
          ],
        },
      },
      {
        id: "workshopPlan",
        type: "longText",
        label: "Workshop plan",
        required: false,
        defaultVisibility: "hidden",
      },
      {
        id: "abstract",
        type: "longText",
        label: "Abstract",
        required: true,
        defaultVisibility: "visible",
      },
      {
        id: "consent",
        type: "consent",
        label: "I agree that this proposal may be reviewed for this synthetic event.",
        required: true,
        defaultVisibility: "visible",
      },
    ],
    rules: {
      schema: FORM_RULES_SCHEMA,
      rules: [
        {
          id: "show-workshop-plan",
          condition: { kind: "field", fieldId: "format", operator: "equals", value: "Workshop" },
          actions: [
            { type: "show", targetFieldId: "workshopPlan" },
            { type: "require", targetFieldId: "workshopPlan" },
          ],
        },
      ],
    },
  });
  if (formVersion.id !== EVALUATOR_FORM_VERSION_ID || formVersion.ruleVersionId !== EVALUATOR_RULE_VERSION_ID) {
    throw new Error("evaluator form dependency IDs drifted");
  }

  const call = formPersistence.createCall(db, organizer, {
    eventId: EVALUATOR_EVENT_ID,
    name: "Stagecraft 2026 Call for Proposals",
    slug: EVALUATOR_CALL_SLUG,
    formVersionId: formVersion.id,
    accessMode: "PUBLIC",
    state: "OPEN",
    timezone: "UTC",
    opensAt: "2026-08-01T00:00:00.000Z",
    closesAt: "2026-12-31T23:59:59.000Z",
    policy: {
      disclosure: {
        privacy: "Synthetic-only evaluator data; no real applicant information is used.",
        retention: "Synthetic proposal records remain local to this evaluator install.",
        aiProcessing: "No AI review is claimed by this fixture.",
        communication: "Synthetic communication only.",
        consent: "Proposal review is limited to this synthetic event.",
        publication: "Accepted synthetic proposals may appear in the seeded publication projection.",
      },
      choices: [
        {
          fieldId: "consent",
          statement: "I agree that this synthetic proposal may be reviewed and published for evaluation.",
          required: true,
        },
      ],
    },
  });
  if (call.id !== EVALUATOR_CALL_ID) throw new Error("evaluator call dependency ID drifted");

  const minaTokenHash = insertApplicantAccess(db, EVALUATOR_SPEAKER_PERSON_ID, MINA_EMAIL, "mina-park");
  const noorTokenHash = insertApplicantAccess(db, EVALUATOR_SUBMITTED_PERSON_ID, NOOR_EMAIL, "noor-haddad");
  const irisTokenHash = insertApplicantAccess(db, EVALUATOR_DRAFT_PERSON_ID, IRIS_EMAIL, "iris-cole");

  const minaSubmission = formPersistence.createDraftSubmission(
    db,
    { workspaceId: EVALUATOR_WORKSPACE_ID, sessionId: deterministicUuid("evaluator-demo:applicant-session:mina-park") },
    { callId: EVALUATOR_CALL_ID },
  );
  const minaAnswers = [
    { fieldId: "title", value: MINA_TITLE },
    { fieldId: "track", value: "Main stage" },
    { fieldId: "format", value: "Talk" },
    { fieldId: "abstract", value: MINA_ABSTRACT },
    { fieldId: "consent", value: true },
  ];
  const minaRevision = formPersistence.saveDraftRevision(
    db,
    { workspaceId: EVALUATOR_WORKSPACE_ID, sessionId: deterministicUuid("evaluator-demo:applicant-session:mina-park") },
    { submissionId: minaSubmission.id, historicalAnswers: minaAnswers, expectedCurrentRevisionId: null },
  );
  const minaSubmitted = submitSubmission(db, {
    workspaceId: EVALUATOR_WORKSPACE_ID,
    callId: EVALUATOR_CALL_ID,
    sessionTokenHash: minaTokenHash,
    submissionId: minaSubmission.id,
    historicalAnswers: minaAnswers,
    expectedCurrentRevisionId: minaRevision.revisionId,
  });

  const noorSubmission = formPersistence.createDraftSubmission(
    db,
    { workspaceId: EVALUATOR_WORKSPACE_ID, sessionId: deterministicUuid("evaluator-demo:applicant-session:noor-haddad") },
    { callId: EVALUATOR_CALL_ID },
  );
  const noorAnswers = [
    { fieldId: "title", value: NOOR_TITLE },
    { fieldId: "track", value: "Practice rooms" },
    { fieldId: "format", value: "Workshop" },
    { fieldId: "workshopPlan", value: NOOR_WORKSHOP_PLAN },
    { fieldId: "abstract", value: NOOR_ABSTRACT },
    { fieldId: "consent", value: true },
  ];
  const noorRevision = formPersistence.saveDraftRevision(
    db,
    { workspaceId: EVALUATOR_WORKSPACE_ID, sessionId: deterministicUuid("evaluator-demo:applicant-session:noor-haddad") },
    { submissionId: noorSubmission.id, historicalAnswers: noorAnswers, expectedCurrentRevisionId: null },
  );
  submitSubmission(db, {
    workspaceId: EVALUATOR_WORKSPACE_ID,
    callId: EVALUATOR_CALL_ID,
    sessionTokenHash: noorTokenHash,
    submissionId: noorSubmission.id,
    historicalAnswers: noorAnswers,
    expectedCurrentRevisionId: noorRevision.revisionId,
  });

  const irisSubmission = formPersistence.createDraftSubmission(
    db,
    { workspaceId: EVALUATOR_WORKSPACE_ID, sessionId: deterministicUuid("evaluator-demo:applicant-session:iris-cole") },
    { callId: EVALUATOR_CALL_ID },
  );
  formPersistence.saveDraftRevision(
    db,
    { workspaceId: EVALUATOR_WORKSPACE_ID, sessionId: deterministicUuid("evaluator-demo:applicant-session:iris-cole") },
    {
      submissionId: irisSubmission.id,
      historicalAnswers: [{ fieldId: "title", value: "A draft proposal still in progress" }],
      expectedCurrentRevisionId: null,
    },
  );

  return {
    submittedRevisionId: minaSubmitted.revisionId,
    submittedRevisionFingerprint: readSubmissionRevision(
      db,
      EVALUATOR_WORKSPACE_ID,
      minaSubmitted.revisionId,
    ).fingerprint,
  };
}

function seedReview(
  db: Db,
  submittedRevisionId: string,
  submittedRevisionFingerprint: string,
): void {
  db.prepare(
    `INSERT INTO review_rounds
       (id, workspace_id, event_id, call_id, name, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EVALUATOR_ROUND_ID,
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_EVENT_ID,
    EVALUATOR_CALL_ID,
    "Editorial review · Round 1",
    EVALUATOR_ORGANIZER_ACCOUNT_ID,
    SEEDED_AT,
  );
  db.prepare(
    `INSERT INTO review_round_states
       (id, workspace_id, round_id, state, sequence_number, actor_account_id, reason, created_at)
     VALUES (?, ?, ?, 'OPEN', 2, ?, ?, ?)`,
  ).run(
    deterministicUuid("evaluator-demo:review-round-state-open"),
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_ROUND_ID,
    EVALUATOR_ORGANIZER_ACCOUNT_ID,
    "Synthetic evaluator round is ready for reviewer work.",
    SEEDED_OPEN_AT,
  );

  const rubricJson = canonicalJson(RUBRIC_DOCUMENT);
  db.prepare(
    `INSERT INTO rubric_versions
       (id, workspace_id, round_id, version_number, rubric_schema, rubric_json,
        fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
     VALUES (?, ?, ?, 1, 'cfp-rubric/v1', ?, 'sha256-canonical-json-v1', ?, ?, ?)`,
  ).run(
    EVALUATOR_RUBRIC_VERSION_ID,
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_ROUND_ID,
    rubricJson,
    fingerprintOf(RUBRIC_DOCUMENT),
    EVALUATOR_ORGANIZER_ACCOUNT_ID,
    SEEDED_OPEN_AT,
  );

  const organizerSession = createSession(
    db,
    EVALUATOR_ORGANIZER_ACCOUNT_ID,
    EVALUATOR_WORKSPACE_ID,
  ).session;
  sealRubricSemantics(db, organizerSession, {
    workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
    rubricVersionId: EVALUATOR_RUBRIC_VERSION_ID,
    expectedRubricFingerprint: fingerprintOf(RUBRIC_DOCUMENT),
    idempotencyKey: "evaluator-demo-rubric-seal-v1",
    criteria: REVIEW_CRITERIA,
  });

  const assignmentCreatedAt = nowIso();
  db.prepare(
    `INSERT INTO review_assignments
       (id, workspace_id, round_id, rubric_version_id, submission_id,
        submission_revision_id, reviewer_account_id, assigned_by, supersedes_assignment_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    EVALUATOR_ASSIGNMENT_ID,
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_ROUND_ID,
    EVALUATOR_RUBRIC_VERSION_ID,
    EVALUATOR_MINA_SUBMISSION_ID,
    submittedRevisionId,
    EVALUATOR_REVIEWER_ACCOUNT_ID,
    EVALUATOR_ORGANIZER_ACCOUNT_ID,
    assignmentCreatedAt,
  );

  const revision = readSubmissionRevision(
    db,
    EVALUATOR_WORKSPACE_ID,
    submittedRevisionId,
  );
  if (revision.fingerprint !== submittedRevisionFingerprint) {
    throw new Error("evaluator review revision fingerprint drifted");
  }
  const decisions: BlindFieldDecisionInput[] = revision.formDocument.effectiveAnswers.map((answer) => {
    const field = revision.formDocument.fields.find((candidate) => candidate.id === answer.fieldId);
    if (field?.type === "consent") {
      return { sourceFieldId: answer.fieldId, action: "EXCLUDE" };
    }
    return {
      sourceFieldId: answer.fieldId,
      action: "INCLUDE_REDACTED",
      reviewLabel: field?.label ?? answer.fieldId,
      redactedValue: typeof answer.value === "string" ? answer.value : String(answer.value),
    };
  });
  sealBlindReviewArtifact(db, organizerSession, {
    workspaceSlug: EVALUATOR_WORKSPACE_SLUG,
    assignmentId: EVALUATOR_ASSIGNMENT_ID,
    expectedSubmissionRevisionId: submittedRevisionId,
    expectedSubmissionRevisionFingerprint: submittedRevisionFingerprint,
    expectedConflictSequence: 0,
    stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    attestation: BLIND_REVIEW_ATTESTATION,
    idempotencyKey: "evaluator-demo-blind-artifact-v1",
    decisions,
  });
}

function seedPlanAndPublication(db: Db): void {
  const actor = { kind: "account" as const, ref: EVALUATOR_ORGANIZER_ACCOUNT_ID };
  const compiled = compilePlan(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, actor);
  approvePlan(
    db,
    EVALUATOR_WORKSPACE_ID,
    EVALUATOR_EVENT_ID,
    compiled.planVersionId,
    null,
    actor,
  );
  deliverOffers(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, actor);
  const offer = db
    .prepare(
      `SELECT id FROM commitment_offers
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    )
    .get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_SPEAKER_PERSON_ID) as
    | { id: string }
    | undefined;
  if (!offer) throw new Error("evaluator accepted-speaker offer was not created");
  respondToOfferCommand(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, {
    offerId: offer.id,
    response: "accepted",
    commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
  });
  ensureEvaluatorSpeakerProvenance(db);
}

/**
 * Populate one local-only evaluator journey with the existing S0 domain records.
 * The function is intentionally explicit and idempotent: a partial prior attempt fails closed
 * instead of silently presenting an incomplete or cross-tenant fixture.
 */
export function seedEvaluatorDemo(db: Db, artifactOptions?: ArtifactRecordServiceOptions): void {
  const existing = db
    .prepare("SELECT id FROM events WHERE workspace_id = ? AND id = ?")
    .get(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID) as { id: string } | undefined;
  if (existing) {
    if (!evaluatorSeedIsComplete(db)) {
      throw new Error("EVALUATOR_DEMO_INCOMPLETE");
    }
    ensureEvaluatorSpeakerProvenance(db);
    if (artifactOptions) {
      seedEvaluatorArtifactFixtures(db, artifactOptions);
    }
    return;
  }

  insertEvaluatorRoots(db);
  const cfp = seedCfp(db);
  seedReview(db, cfp.submittedRevisionId, cfp.submittedRevisionFingerprint);
  seedPlanAndPublication(db);
  ensureEvaluatorSchedule(db);
  ensureEvaluatorSessionContent(db);
  ensureEvaluatorScheduleApproval(db);
  const artifacts = artifactOptions
    ? seedEvaluatorArtifactFixtures(db, artifactOptions)
    : null;
  if (artifacts) approveEvaluatorPublicationArtifactFixtures(db, artifacts);
  sealRelease(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, { kind: "account", ref: EVALUATOR_ORGANIZER_ACCOUNT_ID });

  seedEvaluatorCompatibility(db);
}
