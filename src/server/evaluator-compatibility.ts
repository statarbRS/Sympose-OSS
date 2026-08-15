import type { Db } from "./db";
import { createSession } from "./auth";
import { canonicalJson, deterministicUuid, fingerprintOf, sha256Hex } from "./canonical";
import {
  BLIND_REVIEW_ATTESTATION,
  BLIND_REVIEW_DISCLOSURE_STAGE,
  type BlindFieldDecisionInput,
} from "./services/cfp-review/artifact-types";
import { sealBlindReviewArtifact, sealRubricSemantics } from "./services/cfp-review/organizer";
import { createCfpPersistence, readSubmissionRevision } from "./services/cfp/form-documents";
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

export const EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG = "devflow" as const;
export const EVALUATOR_COMPATIBILITY_WORKSPACE_NAME = "DevFlow Conf 2027" as const;
export const EVALUATOR_COMPATIBILITY_CALL_SLUG = "devflow-conf-2027" as const;

export const EVALUATOR_COMPATIBILITY_WORKSPACE_ID = deterministicUuid("workspace:devflow");
export const EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID = deterministicUuid(
  "account:devflow-organizer",
);
export const EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID = deterministicUuid(
  "account:evaluator-devflow-reviewer",
);
export const EVALUATOR_COMPATIBILITY_EVENT_ID = deterministicUuid(
  "evaluator-compatibility:event:devflow",
);
export const EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID = deterministicUuid(
  "evaluator-compatibility:program-unit:devflow",
);
export const EVALUATOR_COMPATIBILITY_FORM_DEFINITION_ID = deterministicUuid(
  "evaluator-compatibility:form-definition:devflow",
);
export const EVALUATOR_COMPATIBILITY_FORM_VERSION_ID = deterministicUuid(
  "evaluator-compatibility:form-version:devflow",
);
export const EVALUATOR_COMPATIBILITY_RULE_VERSION_ID = deterministicUuid(
  "evaluator-compatibility:rule-version:devflow",
);
export const EVALUATOR_COMPATIBILITY_CALL_ID = deterministicUuid(
  "evaluator-compatibility:call:devflow",
);
export const EVALUATOR_COMPATIBILITY_ROUND_ID = deterministicUuid(
  "evaluator-compatibility:review-round:devflow",
);
export const EVALUATOR_COMPATIBILITY_RUBRIC_VERSION_ID = deterministicUuid(
  "evaluator-compatibility:rubric:devflow",
);
export const EVALUATOR_COMPATIBILITY_ASSIGNMENT_ID = deterministicUuid(
  "evaluator-compatibility:assignment:devflow",
);
export const EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID = deterministicUuid(
  "evaluator-compatibility:person:priya-raman",
);
export const EVALUATOR_COMPATIBILITY_MARCUS_PERSON_ID = deterministicUuid(
  "evaluator-compatibility:person:marcus-okafor",
);
export const EVALUATOR_COMPATIBILITY_SAM_PERSON_ID = deterministicUuid(
  "evaluator-compatibility:person:sam-whitfield",
);
export const EVALUATOR_COMPATIBILITY_ACCOUNT_PERSON_BINDING_ID = deterministicUuid(
  "evaluator-compatibility:binding:sam-whitfield",
);
export const EVALUATOR_COMPATIBILITY_EVENT_REVIEWER_ASSIGNMENT_ID = deterministicUuid(
  "evaluator-compatibility:event-reviewer-assignment:devflow",
);
export const EVALUATOR_COMPATIBILITY_PRIYA_SUBMISSION_ID = deterministicUuid(
  "evaluator-compatibility:submission:priya-raman",
);
export const EVALUATOR_COMPATIBILITY_MARCUS_SUBMISSION_ID = deterministicUuid(
  "evaluator-compatibility:submission:marcus-okafor",
);

const PROFILE_NAMESPACE = "evaluator-compatibility:devflow";
const SEEDED_AT = "2026-08-01T13:00:00.000Z";
const SEEDED_OPEN_AT = "2026-08-01T13:00:01.000Z";
const EVENT_STARTS_AT = "2027-09-16T09:00:00.000Z";
const EVENT_ENDS_AT = "2027-09-16T17:00:00.000Z";
const SESSION_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

const ORGANIZER_EMAIL = "jordan.alvarez@devflow.example";
const REVIEWER_EMAIL = "sam.whitfield@devflow.example";
const PRIYA_EMAIL = "priya.raman@devflow.example";
const MARCUS_EMAIL = "marcus.okafor@devflow.example";
const SAM_EMAIL = "sam.whitfield@devflow.example";

/** Exact seeded account tuples exposed by the local evaluator organizer/reviewer entry points. */
export const EVALUATOR_COMPATIBILITY_ORGANIZER_LOGIN_ACCOUNT_ALLOWLIST = Object.freeze([
  Object.freeze({
    accountId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    role: "organizer" as const,
    email: ORGANIZER_EMAIL,
  }),
] as const);

export const EVALUATOR_COMPATIBILITY_REVIEWER_LOGIN_ACCOUNT_ALLOWLIST = Object.freeze([
  Object.freeze({
    accountId: EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    role: "reviewer" as const,
    email: REVIEWER_EMAIL,
  }),
] as const);

const PRIYA_TITLE = "Building calm systems for developer teams";
const PRIYA_ABSTRACT =
  "A practical session on turning developer feedback into durable operating decisions without losing the evidence that made the decision understandable.";
const MARCUS_TITLE = "Open source maintenance without guesswork";
const MARCUS_ABSTRACT =
  "A field guide to making maintainer work visible, reviewable, and easier for contributors to join.";

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
  title: "DevFlow Conf 2027 proposal review",
  criteria: REVIEW_CRITERIA,
};

const COMPATIBILITY_PEOPLE = [
  {
    id: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    email: PRIYA_EMAIL,
    fullName: "Priya Raman",
    organization: "Northstar Labs",
    title: "VP Engineering",
    expertise: ["developer platforms", "evidence design"],
    moderatorEligible: true,
    sourceRef: "killmysaas/devflow-conf-2027/priya-raman",
  },
  {
    id: EVALUATOR_COMPATIBILITY_MARCUS_PERSON_ID,
    email: MARCUS_EMAIL,
    fullName: "Marcus Okafor",
    organization: "Open Commons",
    title: "Founder",
    expertise: ["open source", "developer experience"],
    moderatorEligible: false,
    sourceRef: "killmysaas/devflow-conf-2027/marcus-okafor",
  },
] as const;

const COMPATIBILITY_REVIEWER_PERSON = {
  id: EVALUATOR_COMPATIBILITY_SAM_PERSON_ID,
  email: SAM_EMAIL,
  fullName: "Sam Whitfield",
  organization: "DevFlow",
  title: "Review editor",
  expertise: ["proposal review", "developer experience"],
  moderatorEligible: false,
  sourceRef: "killmysaas/devflow-conf-2027/sam-whitfield",
} as const;

export const DEVFLOW_EVALUATOR_PROFILE = Object.freeze({
  schema: "sympose-evaluator-compatibility/v1",
  workspaceSlug: EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
  workspaceName: EVALUATOR_COMPATIBILITY_WORKSPACE_NAME,
  callSlug: EVALUATOR_COMPATIBILITY_CALL_SLUG,
  eventName: EVALUATOR_COMPATIBILITY_WORKSPACE_NAME,
  organizer: Object.freeze({ fullName: "Jordan Alvarez", email: ORGANIZER_EMAIL }),
  reviewer: Object.freeze({ fullName: "Sam Whitfield", email: REVIEWER_EMAIL }),
  people: Object.freeze(
    COMPATIBILITY_PEOPLE.map(({ fullName, email, organization, title }) => ({
      fullName,
      email,
      organization,
      title,
    })),
  ),
  attendee: Object.freeze({ label: "Anonymous attendee", requiresSignIn: false }),
  persistedSurfaces: Object.freeze([
    "workspace",
    "organizer account",
    "reviewer account",
    "canonical people",
    "public CFP and applicant sessions",
    "review assignment and sealed blind artifact",
    "approved commitment and publication release",
    "Priya Raman event-speaker identity, tasks, content versions, and artifact authority",
  ]),
  sharedSurfaceNotes: Object.freeze([
    "The evaluator speaker entry opens Priya Raman's canonical DevFlow assignment and durable task scope.",
    "The walkthrough attendee and widgets remain the separate Acme event's current scoped sealed release and are not relabeled as DevFlow.",
  ]),
});

function profileId(kind: string, value: string): string {
  return deterministicUuid(`${PROFILE_NAMESPACE}:${kind}:${value}`);
}

function createCompatibilityPersistence() {
  const ids = [
    EVALUATOR_COMPATIBILITY_FORM_DEFINITION_ID,
    EVALUATOR_COMPATIBILITY_FORM_VERSION_ID,
    EVALUATOR_COMPATIBILITY_RULE_VERSION_ID,
    profileId("call-policy", "devflow"),
    EVALUATOR_COMPATIBILITY_CALL_ID,
    EVALUATOR_COMPATIBILITY_PRIYA_SUBMISSION_ID,
    profileId("revision", "priya-raman"),
    EVALUATOR_COMPATIBILITY_MARCUS_SUBMISSION_ID,
    profileId("revision", "marcus-okafor"),
  ];
  let index = 0;
  return createCfpPersistence({
    clock: () => SEEDED_AT,
    idGenerator: () => ids[index++] ?? profileId("generated", String(index++)),
  });
}

function count(db: Db, table: string): number {
  const allowedTables = new Set([
    "people",
    "events",
    "calls",
    "submissions",
    "review_assignments",
    "review_rubric_semantics",
    "review_blind_artifacts",
    "publication_releases",
  ]);
  if (!allowedTables.has(table)) throw new Error("unsupported evaluator compatibility count table");
  return (
    db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`)
      .get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID) as { count: number }
  ).count;
}

function compatibilitySeedIsComplete(db: Db): boolean {
  const workspace = db
    .prepare("SELECT slug, name FROM workspaces WHERE id = ?")
    .get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID) as
    | { slug: string; name: string }
    | undefined;
  const event = db
    .prepare(
      `SELECT name, current_plan_version_id AS planVersionId, current_release_id AS releaseId
       FROM events WHERE workspace_id = ? AND id = ?`,
    )
    .get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID) as
    | { name: string; planVersionId: string | null; releaseId: string | null }
    | undefined;
  const call = db
    .prepare("SELECT id, event_id AS eventId, name, slug FROM calls WHERE workspace_id = ?")
    .get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID) as
    | { id: string; eventId: string; name: string; slug: string }
    | undefined;
  const people = db
    .prepare(
      `SELECT id, canonical_email AS email, full_name AS fullName, organization, title
       FROM people WHERE workspace_id = ? ORDER BY id`,
    )
    .all(EVALUATOR_COMPATIBILITY_WORKSPACE_ID) as Array<{
    id: string;
    email: string;
    fullName: string;
    organization: string | null;
    title: string | null;
  }>;
  const submissions = db
    .prepare(
      `SELECT id, owner_person_id AS ownerPersonId, state
       FROM submissions WHERE workspace_id = ? ORDER BY id`,
    )
    .all(EVALUATOR_COMPATIBILITY_WORKSPACE_ID) as Array<{
    id: string;
    ownerPersonId: string;
    state: string;
  }>;
  const assignment = db
    .prepare(
      `SELECT id, submission_id AS submissionId, reviewer_account_id AS reviewerAccountId
       FROM review_assignments WHERE workspace_id = ? AND id = ?`,
    )
    .get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_ASSIGNMENT_ID) as
    | { id: string; submissionId: string; reviewerAccountId: string }
    | undefined;
  const organizer = db
    .prepare(
      `SELECT display_name AS displayName, role, email
       FROM accounts WHERE id = ? AND workspace_id = ?`,
    )
    .get(EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID, EVALUATOR_COMPATIBILITY_WORKSPACE_ID) as
    | { displayName: string; role: string; email: string }
    | undefined;
  const reviewer = db
    .prepare(
      `SELECT display_name AS displayName, role, email
       FROM accounts WHERE id = ? AND workspace_id = ?`,
    )
    .get(EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID, EVALUATOR_COMPATIBILITY_WORKSPACE_ID) as
    | { displayName: string; role: string; email: string }
    | undefined;
  const reviewerPerson = db
    .prepare(
      `SELECT id, canonical_email AS email, full_name AS fullName, organization, title
       FROM people WHERE workspace_id = ? AND id = ?`,
    )
    .get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_SAM_PERSON_ID) as
    | { id: string; email: string; fullName: string; organization: string | null; title: string | null }
    | undefined;
  const accountPersonBinding = db
    .prepare(
      `SELECT id, workspace_id AS workspaceId, account_id AS accountId, person_id AS personId,
              bound_by_account_id AS boundByAccountId, binding_basis AS bindingBasis,
              created_at AS createdAt, fingerprint_algorithm AS fingerprintAlgorithm, fingerprint
       FROM account_person_bindings
       WHERE workspace_id = ? AND id = ?`,
    )
    .get(
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_ACCOUNT_PERSON_BINDING_ID,
    ) as
    | {
        id: string;
        workspaceId: string;
        accountId: string;
        personId: string;
        boundByAccountId: string;
        bindingBasis: string;
        createdAt: string;
        fingerprintAlgorithm: string;
        fingerprint: string;
      }
    | undefined;
  const eventReviewerAssignment = db
    .prepare(
      `SELECT id, workspace_id AS workspaceId, event_id AS eventId,
              reviewer_account_id AS reviewerAccountId, reviewer_person_id AS reviewerPersonId,
              account_person_binding_id AS accountPersonBindingId,
              assigned_by_account_id AS assignedByAccountId, created_at AS createdAt,
              fingerprint_algorithm AS fingerprintAlgorithm, fingerprint
       FROM event_reviewer_assignments
       WHERE workspace_id = ? AND id = ?`,
    )
    .get(
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_REVIEWER_ASSIGNMENT_ID,
    ) as
    | {
        id: string;
        workspaceId: string;
        eventId: string;
        reviewerAccountId: string;
        reviewerPersonId: string;
        accountPersonBindingId: string;
        assignedByAccountId: string;
        createdAt: string;
        fingerprintAlgorithm: string;
        fingerprint: string;
      }
    | undefined;
  const eventReviewerAssignmentState = db
    .prepare(
      `SELECT state, sequence_number AS sequenceNumber, actor_account_id AS actorAccountId,
              created_at AS createdAt
       FROM event_reviewer_assignment_states
       WHERE workspace_id = ? AND event_reviewer_assignment_id = ?
       ORDER BY sequence_number DESC LIMIT 1`,
    )
    .get(
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_REVIEWER_ASSIGNMENT_ID,
    ) as
    | { state: string; sequenceNumber: number; actorAccountId: string; createdAt: string }
    | undefined;
  return (
    workspace?.slug === EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG &&
    workspace.name === EVALUATOR_COMPATIBILITY_WORKSPACE_NAME &&
    organizer?.displayName === "Jordan Alvarez" &&
    organizer.role === "organizer" &&
    organizer.email === ORGANIZER_EMAIL &&
    reviewer?.displayName === "Sam Whitfield" &&
    reviewer.role === "reviewer" &&
    reviewer.email === REVIEWER_EMAIL &&
    event?.name === EVALUATOR_COMPATIBILITY_WORKSPACE_NAME &&
    event?.planVersionId !== null &&
    event?.planVersionId !== undefined &&
    event.releaseId !== null &&
    event.releaseId !== undefined &&
    call?.id === EVALUATOR_COMPATIBILITY_CALL_ID &&
    call?.eventId === EVALUATOR_COMPATIBILITY_EVENT_ID &&
    call?.name === "DevFlow Conf 2027 Call for Proposals" &&
    call?.slug === EVALUATOR_COMPATIBILITY_CALL_SLUG &&
    people.length === COMPATIBILITY_PEOPLE.length + 1 &&
    COMPATIBILITY_PEOPLE.every((expected) =>
      people.some(
        (actual) =>
          actual.id === expected.id &&
          actual.email === expected.email &&
          actual.fullName === expected.fullName &&
          actual.organization === expected.organization &&
          actual.title === expected.title,
      ),
    ) &&
    reviewerPerson?.id === EVALUATOR_COMPATIBILITY_SAM_PERSON_ID &&
    reviewerPerson.email === SAM_EMAIL &&
    reviewerPerson.fullName === "Sam Whitfield" &&
    accountPersonBinding?.workspaceId === EVALUATOR_COMPATIBILITY_WORKSPACE_ID &&
    accountPersonBinding.accountId === EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID &&
    accountPersonBinding.personId === EVALUATOR_COMPATIBILITY_SAM_PERSON_ID &&
    accountPersonBinding.boundByAccountId === EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID &&
    accountPersonBinding.bindingBasis === "pinned synthetic evaluator reviewer" &&
    accountPersonBinding.fingerprintAlgorithm === "sha256-canonical-json-v1" &&
    accountPersonBinding.fingerprint === fingerprintOf({
      schema: "pd01-account-person-binding/v1",
      workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      accountId: EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
      personId: EVALUATOR_COMPATIBILITY_SAM_PERSON_ID,
      boundByAccountId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
      bindingBasis: "pinned synthetic evaluator reviewer",
      createdAt: SEEDED_AT,
    }) &&
    eventReviewerAssignment?.workspaceId === EVALUATOR_COMPATIBILITY_WORKSPACE_ID &&
    eventReviewerAssignment.eventId === EVALUATOR_COMPATIBILITY_EVENT_ID &&
    eventReviewerAssignment.reviewerAccountId === EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID &&
    eventReviewerAssignment.reviewerPersonId === EVALUATOR_COMPATIBILITY_SAM_PERSON_ID &&
    eventReviewerAssignment.accountPersonBindingId === EVALUATOR_COMPATIBILITY_ACCOUNT_PERSON_BINDING_ID &&
    eventReviewerAssignment.assignedByAccountId === EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID &&
    eventReviewerAssignment.fingerprintAlgorithm === "sha256-canonical-json-v1" &&
    eventReviewerAssignment.fingerprint === fingerprintOf({
      schema: "pd01-event-reviewer-assignment/v1",
      workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      reviewerAccountId: EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
      reviewerPersonId: EVALUATOR_COMPATIBILITY_SAM_PERSON_ID,
      accountPersonBindingId: EVALUATOR_COMPATIBILITY_ACCOUNT_PERSON_BINDING_ID,
      assignedByAccountId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
      createdAt: SEEDED_AT,
    }) &&
    eventReviewerAssignmentState?.state === "ACTIVE" &&
    eventReviewerAssignmentState.sequenceNumber === 1 &&
    eventReviewerAssignmentState.actorAccountId === EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID &&
    eventReviewerAssignmentState.createdAt === SEEDED_AT &&
    count(db, "people") === COMPATIBILITY_PEOPLE.length + 1 &&
    count(db, "calls") === 1 &&
    count(db, "submissions") === COMPATIBILITY_PEOPLE.length &&
    submissions.length === COMPATIBILITY_PEOPLE.length &&
    submissions.some(
      (submission) =>
        submission.id === EVALUATOR_COMPATIBILITY_PRIYA_SUBMISSION_ID &&
        submission.ownerPersonId === EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID &&
        submission.state === "SUBMITTED",
    ) &&
    submissions.some(
      (submission) =>
        submission.id === EVALUATOR_COMPATIBILITY_MARCUS_SUBMISSION_ID &&
        submission.ownerPersonId === EVALUATOR_COMPATIBILITY_MARCUS_PERSON_ID &&
        submission.state === "SUBMITTED",
    ) &&
    assignment?.id === EVALUATOR_COMPATIBILITY_ASSIGNMENT_ID &&
    assignment?.submissionId === EVALUATOR_COMPATIBILITY_PRIYA_SUBMISSION_ID &&
    assignment?.reviewerAccountId === EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID &&
    count(db, "review_assignments") === 1 &&
    count(db, "review_rubric_semantics") === 1 &&
    count(db, "review_blind_artifacts") === 1 &&
    count(db, "publication_releases") === 1
  );
}

function assertNoConflictingRoots(db: Db): void {
  const workspaceById = db
    .prepare("SELECT slug, name FROM workspaces WHERE id = ?")
    .get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID) as
    | { slug: string; name: string }
    | undefined;
  if (
    workspaceById &&
    (workspaceById.slug !== EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG ||
      workspaceById.name !== EVALUATOR_COMPATIBILITY_WORKSPACE_NAME)
  ) {
    throw new Error("EVALUATOR_COMPATIBILITY_TENANT_MISMATCH");
  }
  const workspaceBySlug = db
    .prepare("SELECT id, name FROM workspaces WHERE slug = ?")
    .get(EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG) as
    | { id: string; name: string }
    | undefined;
  if (
    workspaceBySlug &&
    (workspaceBySlug.id !== EVALUATOR_COMPATIBILITY_WORKSPACE_ID ||
      workspaceBySlug.name !== EVALUATOR_COMPATIBILITY_WORKSPACE_NAME)
  ) {
    throw new Error("EVALUATOR_COMPATIBILITY_TENANT_MISMATCH");
  }
  const eventById = db
    .prepare("SELECT workspace_id AS workspaceId FROM events WHERE id = ?")
    .get(EVALUATOR_COMPATIBILITY_EVENT_ID) as { workspaceId: string } | undefined;
  if (eventById && eventById.workspaceId !== EVALUATOR_COMPATIBILITY_WORKSPACE_ID) {
    throw new Error("EVALUATOR_COMPATIBILITY_TENANT_MISMATCH");
  }
}

function insertCompatibilityRoots(db: Db): void {
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
  ).run(
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
    EVALUATOR_COMPATIBILITY_WORKSPACE_NAME,
    SEEDED_AT,
  );
  db.prepare(
    `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
     VALUES (?, ?, ?, ?, 'organizer', ?)`,
  ).run(
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    ORGANIZER_EMAIL,
    "Jordan Alvarez",
    SEEDED_AT,
  );
  db.prepare(
    `INSERT INTO accounts (id, workspace_id, email, display_name, role, created_at)
     VALUES (?, ?, ?, ?, 'reviewer', ?)`,
  ).run(
    EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    REVIEWER_EMAIL,
    "Sam Whitfield",
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
     VALUES (?, ?, 'evaluator-compatibility', ?, 1, ?, ?)`,
  );
  const insertLink = db.prepare(
    `INSERT INTO source_links
       (id, workspace_id, person_id, source_record_id, link_decision, created_at)
     VALUES (?, ?, ?, ?, 'matched', ?)`,
  );
  for (const person of COMPATIBILITY_PEOPLE) {
    insertPerson.run(
      person.id,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      person.email,
      person.fullName,
      person.organization,
      person.title,
      SEEDED_AT,
    );
    const sourceRecordId = profileId("source-record", person.id);
    insertSource.run(
      sourceRecordId,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      person.sourceRef,
      canonicalJson({
        schema: "evaluator-compatibility-source/v1",
        profile: EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
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
      profileId("source-link", person.id),
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      person.id,
      sourceRecordId,
      SEEDED_AT,
    );
  }
  insertPerson.run(
    COMPATIBILITY_REVIEWER_PERSON.id,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    COMPATIBILITY_REVIEWER_PERSON.email,
    COMPATIBILITY_REVIEWER_PERSON.fullName,
    COMPATIBILITY_REVIEWER_PERSON.organization,
    COMPATIBILITY_REVIEWER_PERSON.title,
    SEEDED_AT,
  );
  const reviewerSourceRecordId = profileId("source-record", COMPATIBILITY_REVIEWER_PERSON.id);
  insertSource.run(
    reviewerSourceRecordId,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    COMPATIBILITY_REVIEWER_PERSON.sourceRef,
    canonicalJson({
      schema: "evaluator-compatibility-source/v1",
      profile: EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
      record: {
        email: COMPATIBILITY_REVIEWER_PERSON.email,
        fullName: COMPATIBILITY_REVIEWER_PERSON.fullName,
        organization: COMPATIBILITY_REVIEWER_PERSON.organization,
        title: COMPATIBILITY_REVIEWER_PERSON.title,
        expertise: COMPATIBILITY_REVIEWER_PERSON.expertise,
        moderatorEligible: COMPATIBILITY_REVIEWER_PERSON.moderatorEligible,
      },
    }),
    SEEDED_AT,
  );
  insertLink.run(
    profileId("source-link", COMPATIBILITY_REVIEWER_PERSON.id),
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    COMPATIBILITY_REVIEWER_PERSON.id,
    reviewerSourceRecordId,
    SEEDED_AT,
  );

  db.prepare(
    `INSERT INTO events
       (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, 'UTC', ?, ?, 'planning', ?)`,
  ).run(
    EVALUATOR_COMPATIBILITY_EVENT_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_NAME,
    EVENT_STARTS_AT,
    EVENT_ENDS_AT,
    SEEDED_AT,
  );
  db.prepare(
    `INSERT INTO program_units
       (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
     VALUES (?, ?, ?, ?, 'session', ?, ?, 120, ?)`,
  ).run(
    EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_EVENT_ID,
    "Building calm developer systems",
    "2027-09-16T10:00:00.000Z",
    "2027-09-16T10:45:00.000Z",
    SEEDED_AT,
  );

  const cohortDefinitionId = profileId("cohort-definition", "devflow");
  const snapshotId = profileId("cohort-snapshot", "devflow");
  const snapshotMembers = [
    {
      personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      rank: 1,
      whyIn: "Priya Raman is the accepted speaker fixture selected for the seeded DevFlow session.",
    },
  ];
  const snapshotFingerprint = fingerprintOf({
    schema: "cohort-snapshot/v1",
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    cohortName: "DevFlow accepted speaker cohort",
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
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    "DevFlow accepted speaker cohort",
    canonicalJson({
      name: "DevFlow accepted speaker cohort",
      version: 1,
      purpose: "seed one accepted speaker/session path for evaluator compatibility",
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
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
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
    profileId("cohort-member", "priya-raman"),
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    snapshotId,
    EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    1,
    snapshotMembers[0]!.whyIn,
  );
}

function insertApplicantAccess(db: Db, personId: string, email: string, suffix: string): string {
  const verificationId = profileId("verification", suffix);
  const applicantSessionId = profileId("applicant-session", suffix);
  const tokenHash = sha256Hex(`${PROFILE_NAMESPACE}:applicant-session:${suffix}`);
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verificationId,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_CALL_ID,
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
    profileId("verification-consumption", suffix),
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
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
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_CALL_ID,
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
  const formPersistence = createCompatibilityPersistence();
  const organizer = {
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    accountId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  };
  const formDefinition = formPersistence.createFormDefinition(db, organizer, {
    name: "DevFlow Conf 2027 proposal form",
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
  if (
    formVersion.id !== EVALUATOR_COMPATIBILITY_FORM_VERSION_ID ||
    formVersion.ruleVersionId !== EVALUATOR_COMPATIBILITY_RULE_VERSION_ID
  ) {
    throw new Error("evaluator compatibility form dependency IDs drifted");
  }

  const call = formPersistence.createCall(db, organizer, {
    eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
    name: "DevFlow Conf 2027 Call for Proposals",
    slug: EVALUATOR_COMPATIBILITY_CALL_SLUG,
    formVersionId: formVersion.id,
    accessMode: "PUBLIC",
    state: "OPEN",
    timezone: "UTC",
    opensAt: "2026-08-12T00:00:00.000Z",
    closesAt: "2027-06-30T23:59:59.000Z",
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
  if (call.id !== EVALUATOR_COMPATIBILITY_CALL_ID) {
    throw new Error("evaluator compatibility call dependency ID drifted");
  }

  const priyaTokenHash = insertApplicantAccess(
    db,
    EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    PRIYA_EMAIL,
    "priya-raman",
  );
  const marcusTokenHash = insertApplicantAccess(
    db,
    EVALUATOR_COMPATIBILITY_MARCUS_PERSON_ID,
    MARCUS_EMAIL,
    "marcus-okafor",
  );

  const priyaSessionId = profileId("applicant-session", "priya-raman");
  const priyaSubmission = formPersistence.createDraftSubmission(
    db,
    { workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID, sessionId: priyaSessionId },
    { callId: EVALUATOR_COMPATIBILITY_CALL_ID },
  );
  const priyaAnswers = [
    { fieldId: "title", value: PRIYA_TITLE },
    { fieldId: "track", value: "Main stage" },
    { fieldId: "format", value: "Talk" },
    { fieldId: "abstract", value: PRIYA_ABSTRACT },
    { fieldId: "consent", value: true },
  ];
  const priyaRevision = formPersistence.saveDraftRevision(
    db,
    { workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID, sessionId: priyaSessionId },
    {
      submissionId: priyaSubmission.id,
      historicalAnswers: priyaAnswers,
      expectedCurrentRevisionId: null,
    },
  );
  const priyaSubmitted = submitSubmission(db, {
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    callId: EVALUATOR_COMPATIBILITY_CALL_ID,
    sessionTokenHash: priyaTokenHash,
    submissionId: priyaSubmission.id,
    historicalAnswers: priyaAnswers,
    expectedCurrentRevisionId: priyaRevision.revisionId,
  });

  const marcusSessionId = profileId("applicant-session", "marcus-okafor");
  const marcusSubmission = formPersistence.createDraftSubmission(
    db,
    { workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID, sessionId: marcusSessionId },
    { callId: EVALUATOR_COMPATIBILITY_CALL_ID },
  );
  const marcusAnswers = [
    { fieldId: "title", value: MARCUS_TITLE },
    { fieldId: "track", value: "Practice rooms" },
    { fieldId: "format", value: "Workshop" },
    { fieldId: "workshopPlan", value: "Participants map one maintenance decision to observable evidence and a reviewable next step." },
    { fieldId: "abstract", value: MARCUS_ABSTRACT },
    { fieldId: "consent", value: true },
  ];
  const marcusRevision = formPersistence.saveDraftRevision(
    db,
    { workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID, sessionId: marcusSessionId },
    {
      submissionId: marcusSubmission.id,
      historicalAnswers: marcusAnswers,
      expectedCurrentRevisionId: null,
    },
  );
  submitSubmission(db, {
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    callId: EVALUATOR_COMPATIBILITY_CALL_ID,
    sessionTokenHash: marcusTokenHash,
    submissionId: marcusSubmission.id,
    historicalAnswers: marcusAnswers,
    expectedCurrentRevisionId: marcusRevision.revisionId,
  });

  return {
    submittedRevisionId: priyaSubmitted.revisionId,
    submittedRevisionFingerprint: readSubmissionRevision(
      db,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      priyaSubmitted.revisionId,
    ).fingerprint,
  };
}

function seedReview(db: Db, submittedRevisionId: string, submittedRevisionFingerprint: string): void {
  db.prepare(
    `INSERT INTO review_rounds
       (id, workspace_id, event_id, call_id, name, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EVALUATOR_COMPATIBILITY_ROUND_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_EVENT_ID,
    EVALUATOR_COMPATIBILITY_CALL_ID,
    "DevFlow editorial review · Round 1",
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    SEEDED_AT,
  );
  db.prepare(
    `INSERT INTO review_round_states
       (id, workspace_id, round_id, state, sequence_number, actor_account_id, reason, created_at)
     VALUES (?, ?, ?, 'OPEN', 2, ?, ?, ?)`,
  ).run(
    profileId("review-round-state", "open"),
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_ROUND_ID,
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    "Synthetic DevFlow evaluator round is ready for reviewer work.",
    SEEDED_OPEN_AT,
  );

  const rubricJson = canonicalJson(RUBRIC_DOCUMENT);
  db.prepare(
    `INSERT INTO rubric_versions
       (id, workspace_id, round_id, version_number, rubric_schema, rubric_json,
        fingerprint_algorithm, fingerprint, sealed_by, sealed_at)
     VALUES (?, ?, ?, 1, 'cfp-rubric/v1', ?, 'sha256-canonical-json-v1', ?, ?, ?)`,
  ).run(
    EVALUATOR_COMPATIBILITY_RUBRIC_VERSION_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_ROUND_ID,
    rubricJson,
    fingerprintOf(RUBRIC_DOCUMENT),
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    SEEDED_OPEN_AT,
  );

  const organizerSession = createSession(
    db,
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
  ).session;
  sealRubricSemantics(db, organizerSession, {
    workspaceSlug: EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
    rubricVersionId: EVALUATOR_COMPATIBILITY_RUBRIC_VERSION_ID,
    expectedRubricFingerprint: fingerprintOf(RUBRIC_DOCUMENT),
    idempotencyKey: "evaluator-compatibility-devflow-rubric-seal-v1",
    criteria: REVIEW_CRITERIA,
  });

  db.prepare(
    `INSERT INTO review_assignments
       (id, workspace_id, round_id, rubric_version_id, submission_id,
        submission_revision_id, reviewer_account_id, assigned_by, supersedes_assignment_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    EVALUATOR_COMPATIBILITY_ASSIGNMENT_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_ROUND_ID,
    EVALUATOR_COMPATIBILITY_RUBRIC_VERSION_ID,
    EVALUATOR_COMPATIBILITY_PRIYA_SUBMISSION_ID,
    submittedRevisionId,
    EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    SEEDED_OPEN_AT,
  );

  const bindingBasis = "pinned synthetic evaluator reviewer";
  db.prepare(
    `INSERT INTO account_person_bindings
       (id, workspace_id, account_id, person_id, bound_by_account_id, binding_basis,
        created_at, fingerprint_algorithm, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'sha256-canonical-json-v1', ?)`,
  ).run(
    EVALUATOR_COMPATIBILITY_ACCOUNT_PERSON_BINDING_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
    EVALUATOR_COMPATIBILITY_SAM_PERSON_ID,
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    bindingBasis,
    SEEDED_AT,
    fingerprintOf({
      schema: "pd01-account-person-binding/v1",
      workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      accountId: EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
      personId: EVALUATOR_COMPATIBILITY_SAM_PERSON_ID,
      boundByAccountId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
      bindingBasis,
      createdAt: SEEDED_AT,
    }),
  );
  db.prepare(
    `INSERT INTO event_reviewer_assignments
       (id, workspace_id, event_id, reviewer_account_id, reviewer_person_id,
        account_person_binding_id, assigned_by_account_id, created_at,
        fingerprint_algorithm, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sha256-canonical-json-v1', ?)`,
  ).run(
    EVALUATOR_COMPATIBILITY_EVENT_REVIEWER_ASSIGNMENT_ID,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_EVENT_ID,
    EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
    EVALUATOR_COMPATIBILITY_SAM_PERSON_ID,
    EVALUATOR_COMPATIBILITY_ACCOUNT_PERSON_BINDING_ID,
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    SEEDED_AT,
    fingerprintOf({
      schema: "pd01-event-reviewer-assignment/v1",
      workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
      reviewerAccountId: EVALUATOR_COMPATIBILITY_REVIEWER_ACCOUNT_ID,
      reviewerPersonId: EVALUATOR_COMPATIBILITY_SAM_PERSON_ID,
      accountPersonBindingId: EVALUATOR_COMPATIBILITY_ACCOUNT_PERSON_BINDING_ID,
      assignedByAccountId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
      createdAt: SEEDED_AT,
    }),
  );
  db.prepare(
    `INSERT INTO event_reviewer_assignment_states
       (id, workspace_id, event_id, event_reviewer_assignment_id, state,
        sequence_number, actor_account_id, reason, created_at)
     VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?)`,
  ).run(
    profileId("event-reviewer-assignment-state", "active"),
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_EVENT_ID,
    EVALUATOR_COMPATIBILITY_EVENT_REVIEWER_ASSIGNMENT_ID,
    EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    "Pinned synthetic reviewer assignment is active for the evaluator round.",
    SEEDED_AT,
  );

  const revision = readSubmissionRevision(
    db,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    submittedRevisionId,
  );
  if (revision.fingerprint !== submittedRevisionFingerprint) {
    throw new Error("evaluator compatibility review revision fingerprint drifted");
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
    workspaceSlug: EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
    assignmentId: EVALUATOR_COMPATIBILITY_ASSIGNMENT_ID,
    expectedSubmissionRevisionId: submittedRevisionId,
    expectedSubmissionRevisionFingerprint: submittedRevisionFingerprint,
    expectedConflictSequence: 0,
    stage: BLIND_REVIEW_DISCLOSURE_STAGE,
    attestation: BLIND_REVIEW_ATTESTATION,
    idempotencyKey: "evaluator-compatibility-devflow-blind-artifact-v1",
    decisions,
  });
}

function seedPlanAndPublication(db: Db): void {
  const actor = {
    kind: "account" as const,
    ref: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  };
  const compiled = compilePlan(
    db,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_EVENT_ID,
    actor,
  );
  approvePlan(
    db,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_EVENT_ID,
    compiled.planVersionId,
    null,
    actor,
  );
  deliverOffers(
    db,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_EVENT_ID,
    actor,
  );
  const offer = db
    .prepare(
      `SELECT id FROM commitment_offers
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    )
    .get(
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    ) as { id: string } | undefined;
  if (!offer) throw new Error("evaluator compatibility accepted-speaker offer was not created");
  respondToOfferCommand(db, EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID, {
    offerId: offer.id,
    response: "accepted",
    commandKey: commitmentResponseCommandKey(offer.id, "accepted"),
  });
  ensureCompatibilitySpeakerProvenance(db);
  ensureCompatibilitySchedule(db);
  ensureCompatibilitySessionContent(db);
  ensureCompatibilityScheduleApproval(db);
  sealRelease(
    db,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_EVENT_ID,
    actor,
  );
}

function ensureCompatibilityScheduleApproval(db: Db): void {
  const scope = {
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
  };
  let current = readScheduleDraft(db, scope);
  if (!current.persisted) {
    executeScheduleDraftCommand(db, scope, {
      expectedRevision: current.schedule.revision,
      planVersionId: current.schedule.planVersionId,
      planFingerprint: current.schedule.planFingerprint,
      acceptedInventoryFingerprint: current.schedule.acceptedInventoryFingerprint,
      cfpSessionInventoryFingerprint: current.schedule.cfpSessionInventoryFingerprint,
      command: { kind: "AUTO_PLACE", reason: "Materialize the seeded DevFlow schedule" },
      idempotencyKey: "devflow-schedule-materialization-v1",
      requestId: "devflow-schedule-materialization-request-v1",
      actorAccountId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
    });
    current = readScheduleDraft(db, scope);
  }
  if (readCurrentScheduleApproval(db, scope)) return;
  if (!current.pointer) throw new Error("EVALUATOR_COMPATIBILITY_SCHEDULE_POINTER_UNAVAILABLE");
  approveScheduleDraft(db, scope, {
    expectedRevision: current.schedule.revision,
    expectedScheduleAuthorityFingerprint: fingerprintOf(scheduleApprovalSubject(current.pointer)),
    idempotencyKey: "devflow-schedule-approval-v1",
    requestId: "devflow-schedule-approval-request-v1",
    actorAccountId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  });
}

function ensureCompatibilitySchedule(db: Db): void {
  const roomId = profileId("room", "default");
  const trackId = profileId("track", "default");
  const allocationId = profileId("allocation", "priya-raman");
  db.prepare(
    `INSERT OR IGNORE INTO event_rooms
       (id, workspace_id, event_id, name, capacity, created_at)
     VALUES (?, ?, ?, 'DevFlow room', 120, ?)`,
  ).run(roomId, EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID, SEEDED_AT);
  db.prepare(
    `INSERT OR IGNORE INTO event_tracks
       (id, workspace_id, event_id, name, slug, created_at)
     VALUES (?, ?, ?, 'DevFlow track', 'devflow-track', ?)`,
  ).run(trackId, EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID, SEEDED_AT);
  db.prepare(
    `INSERT OR IGNORE INTO event_session_allocations
       (id, workspace_id, event_id, program_unit_id, room_id, track_id,
        starts_at, ends_at, allocation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
  ).run(
    allocationId,
    EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    EVALUATOR_COMPATIBILITY_EVENT_ID,
    EVALUATOR_COMPATIBILITY_PROGRAM_UNIT_ID,
    roomId,
    trackId,
    "2027-09-16T10:00:00.000Z",
    "2027-09-16T10:45:00.000Z",
    SEEDED_AT,
    SEEDED_AT,
  );
}

function ensureCompatibilitySpeakerProvenance(db: Db): void {
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
    .all(
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
    ) as unknown as readonly { assignmentRole: unknown; termsJson: unknown }[];
  if (assignmentRows.length !== 1) throw new Error("EVALUATOR_COMPATIBILITY_SPEAKER_AUTHORITY_INVALID");
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
    throw new Error("EVALUATOR_COMPATIBILITY_SPEAKER_AUTHORITY_INVALID");
  }
  const role = normalizeRole(assignmentRows[0]?.assignmentRole);
  if (role === null || normalizeRole(offerRole) !== role) {
    throw new Error("EVALUATOR_COMPATIBILITY_SPEAKER_AUTHORITY_INVALID");
  }
  const speakerId = profileId("event-speaker", "priya-raman");
  const existing = db
    .prepare(
      `SELECT id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at
       FROM event_speakers WHERE id = ? AND workspace_id = ?`,
    )
    .get(speakerId, EVALUATOR_COMPATIBILITY_WORKSPACE_ID) as
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
    ).run(
      speakerId,
      EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
      EVALUATOR_COMPATIBILITY_EVENT_ID,
      EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
      role,
      SEEDED_AT,
      SEEDED_AT,
    );
    return;
  }
  if (
    existing.event_id !== EVALUATOR_COMPATIBILITY_EVENT_ID ||
    existing.person_id !== EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID ||
    existing.role_key !== role ||
    existing.participation_status !== "CONFIRMED" ||
    existing.created_at !== SEEDED_AT ||
    existing.updated_at !== SEEDED_AT
  ) {
    throw new Error("EVALUATOR_COMPATIBILITY_SPEAKER_PROVENANCE_INVALID");
  }
}

function ensureCompatibilitySessionContent(db: Db): void {
  const speaker = createSyntheticSpeakerOperationsRepository({ db, clock: () => SEEDED_AT });
  const scope = {
    kind: "organizer" as const,
    workspaceId: EVALUATOR_COMPATIBILITY_WORKSPACE_ID,
    eventId: EVALUATOR_COMPATIBILITY_EVENT_ID,
    actorId: EVALUATOR_COMPATIBILITY_ORGANIZER_ACCOUNT_ID,
  };
  const titleTask = speaker.createTask(scope, {
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    kind: "SESSION_TITLE",
    contentKind: "SESSION_TITLE",
    title: "Session title",
    description: "The exact audience-facing title for the compatibility program.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2027-08-25T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: "evaluator-compatibility-session-title-task",
  });
  const abstractTask = speaker.createTask(scope, {
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    kind: "SESSION_DESCRIPTION",
    contentKind: "SESSION_DESCRIPTION",
    title: "Session description",
    description: "The exact audience-facing abstract for the compatibility program.",
    required: true,
    gate: "PUBLICATION",
    dueAt: "2027-08-25T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: "evaluator-compatibility-session-description-task",
  });
  speaker.createTask(scope, {
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    kind: "HEADSHOT",
    contentKind: "HEADSHOT",
    title: "Speaker headshot",
    description: "Submit a bounded PNG as a new immutable artifact version for organizer review.",
    required: false,
    gate: "OPERATOR_RELEASE",
    dueAt: "2027-08-25T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: "evaluator-compatibility-headshot-task",
  });
  speaker.createTask(scope, {
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    kind: "SLIDES",
    contentKind: "SLIDES",
    title: "Session slides",
    description: "Submit a bounded PDF as a new immutable artifact version for organizer review.",
    required: false,
    gate: "OPERATOR_RELEASE",
    dueAt: "2027-09-10T17:00:00.000Z",
    owner: "SPEAKER",
    idempotencyKey: "evaluator-compatibility-slides-task",
  });
  const title = speaker.submitOrganizerContent(scope, {
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    taskId: titleTask.id,
    payload: { kind: "SESSION_TITLE", title: PRIYA_TITLE },
    idempotencyKey: "evaluator-compatibility-session-title-version",
  });
  const abstract = speaker.submitOrganizerContent(scope, {
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    taskId: abstractTask.id,
    payload: { kind: "SESSION_DESCRIPTION", description: PRIYA_ABSTRACT },
    idempotencyKey: "evaluator-compatibility-session-description-version",
  });
  speaker.approveContent(scope, {
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    taskId: titleTask.id,
    submissionVersionId: title.id,
    submissionContentHash: title.contentHash,
    gate: "PUBLICATION",
    idempotencyKey: "evaluator-compatibility-session-title-approval",
  });
  speaker.approveContent(scope, {
    personId: EVALUATOR_COMPATIBILITY_PRIYA_PERSON_ID,
    taskId: abstractTask.id,
    submissionVersionId: abstract.id,
    submissionContentHash: abstract.contentHash,
    gate: "PUBLICATION",
    idempotencyKey: "evaluator-compatibility-session-description-approval",
  });
}

function runInSeedTransaction<T>(db: Db, fn: () => T): T {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    if (ownsTransaction) db.exec("COMMIT");
    return result;
  } catch (error) {
    if (ownsTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the domain failure if rollback itself is unavailable.
      }
    }
    throw error;
  }
}

/** Seed the isolated DevFlow compatibility profile without changing the existing Acme fixture. */
export function seedEvaluatorCompatibility(db: Db): void {
  assertNoConflictingRoots(db);
  const existing = db
    .prepare(
      "SELECT id FROM events WHERE workspace_id = ? AND id = ?",
    )
    .get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_EVENT_ID) as
    | { id: string }
    | undefined;
  if (existing) {
    if (!compatibilitySeedIsComplete(db)) {
      throw new Error("EVALUATOR_COMPATIBILITY_INCOMPLETE");
    }
    return;
  }
  const workspace = db
    .prepare("SELECT id FROM workspaces WHERE id = ? OR slug = ?")
    .get(EVALUATOR_COMPATIBILITY_WORKSPACE_ID, EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG) as
    | { id: string }
    | undefined;
  if (workspace) {
    throw new Error("EVALUATOR_COMPATIBILITY_INCOMPLETE");
  }

  const cfp = runInSeedTransaction(db, () => {
    assertNoConflictingRoots(db);
    insertCompatibilityRoots(db);
    return seedCfp(db);
  });
  seedReview(db, cfp.submittedRevisionId, cfp.submittedRevisionFingerprint);
  seedPlanAndPublication(db);
}
