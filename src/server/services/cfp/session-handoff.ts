import { canonicalJson, deterministicUuid, fingerprintOf } from "../../canonical";
import { withTransactionOrSavepoint, type Db } from "../../db";
import { roleHasCapability } from "../../auth";
import type { CfpLinkedSessionStatus } from "./decision-types";
import {
  bindSubmissionToLineage,
  createProposalLineage,
  type ProposalLineageActor,
} from "./proposal-lineage";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const MULTILINE_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

const LEGACY_CFP_SESSION_HANDOFF_SCHEMA = "cfp-session-handoff/v1" as const;
const LINEAGE_CFP_SESSION_HANDOFF_SCHEMA = "cfp-session-handoff/v2" as const;
export const CFP_SESSION_HANDOFF_SCHEMA = "cfp-session-handoff/v3" as const;
export const CFP_SESSION_HANDOFF_CREATED_STATUS = "UNSCHEDULED" as const;
export const CFP_SESSION_MINIMUM_CAPACITY = 1 as const;
export const CFP_SESSION_DEFAULT_DURATION_MINUTES = 45 as const;
export const CFP_SESSION_MAXIMUM_DURATION_MINUTES = 720 as const;
const CFP_ACCEPTED_PROPOSAL_DISPLAY_SCHEMA = "cfp-accepted-proposal-display/v1" as const;
const CFP_FALLBACK_TRACK_NAME = "Unassigned CFP track" as const;

export type CfpSessionDurationSource =
  | "PROPOSAL_ANSWER"
  | "FORMAT_OPTION"
  | "CANONICAL_DEFAULT";

export type CfpSessionTrackSource = "PROPOSAL" | "CANONICAL_FALLBACK";

export interface LegacyCfpSessionHandoffEvidence {
  readonly schema: typeof LEGACY_CFP_SESSION_HANDOFF_SCHEMA;
  readonly eventId: string;
  readonly programUnitId: string;
  readonly sourceSubmissionId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevisionFingerprint: string;
  readonly speakerPersonId: string;
  readonly speakerLinkId: string | null;
  readonly createdStatus: typeof CFP_SESSION_HANDOFF_CREATED_STATUS;
}

export interface LineageCfpSessionHandoffEvidence {
  readonly schema: typeof LINEAGE_CFP_SESSION_HANDOFF_SCHEMA;
  readonly eventId: string;
  readonly programUnitId: string;
  readonly proposalLineageId: string;
  readonly sourceSubmissionId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevisionFingerprint: string;
  readonly speakerPersonId: string;
  readonly speakerLinkId: string | null;
  readonly capacity: typeof CFP_SESSION_MINIMUM_CAPACITY;
  readonly createdStatus: typeof CFP_SESSION_HANDOFF_CREATED_STATUS;
}

export interface CfpSessionHandoffEvidence {
  readonly schema: typeof CFP_SESSION_HANDOFF_SCHEMA;
  readonly eventId: string;
  readonly programUnitId: string;
  readonly programUnitName: string;
  readonly proposalLineageId: string;
  readonly sourceSubmissionId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevisionFingerprint: string;
  readonly speakerPersonId: string;
  readonly speakerLinkId: string | null;
  readonly capacity: typeof CFP_SESSION_MINIMUM_CAPACITY;
  readonly format: string | null;
  readonly durationMinutes: number;
  readonly durationSource: CfpSessionDurationSource;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly proposalTrack: string | null;
  readonly trackId: string;
  readonly trackName: string;
  readonly trackSource: CfpSessionTrackSource;
  readonly createdStatus: typeof CFP_SESSION_HANDOFF_CREATED_STATUS;
}

export type ReadableCfpSessionHandoffEvidence =
  | LegacyCfpSessionHandoffEvidence
  | LineageCfpSessionHandoffEvidence
  | CfpSessionHandoffEvidence;

export interface CfpSessionPlacementProjection {
  readonly roomId: string;
  readonly roomName: string;
  readonly trackId: string;
  readonly trackName: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface CfpSessionHandoffProjection {
  readonly eventId: string;
  readonly programUnitId: string;
  readonly proposalLineageId: string | null;
  readonly sourceSubmissionId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevisionFingerprint: string;
  readonly speakerPersonId: string;
  readonly speakerLinkId: string | null;
  readonly name: string;
  readonly unitType: "session";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly capacity: number;
  readonly format: string | null;
  readonly durationMinutes: number;
  readonly durationSource: CfpSessionDurationSource;
  readonly proposalTrack: string | null;
  readonly trackId: string;
  readonly trackName: string;
  readonly trackSource: CfpSessionTrackSource;
  readonly status: CfpLinkedSessionStatus;
  readonly placement: CfpSessionPlacementProjection | null;
  readonly release: {
    readonly sealedAt: string;
    readonly releaseNumber: number | null;
  } | null;
}

export interface EnsureCfpSessionHandoffInput {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly submissionId: string;
  readonly revisionId: string;
  readonly revisionFingerprint: string;
  readonly speakerPersonId: string;
  readonly actor: ProposalLineageActor;
  readonly title: string;
  readonly abstract: string | null;
  readonly format: string | null;
  readonly track: string | null;
  readonly trackRequired: boolean;
  readonly requestedDurationMinutes: number | null;
  readonly requestedDurationSource: Exclude<CfpSessionDurationSource, "CANONICAL_DEFAULT"> | null;
  readonly createdAt: string;
}

export class CfpSessionHandoffError extends Error {
  constructor() {
    super("The accepted CFP proposal could not be linked to a real event session safely.");
    this.name = "CfpSessionHandoffError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function fail(): never {
  throw new CfpSessionHandoffError();
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) return fail();
  return value;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) return fail();
  return value;
}

function safeText(value: unknown, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return fail();
  }
  return value.trim();
}

function optionalSafeText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    MULTILINE_CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return fail();
  }
  return value.trim();
}

function safeInstant(value: unknown): string {
  const textValue = safeText(value);
  const timestamp = Date.parse(textValue);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== textValue) return fail();
  return textValue;
}

function boundedDuration(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CFP_SESSION_MAXIMUM_DURATION_MINUTES
  ) {
    return fail();
  }
  return value;
}

function addMinutes(startsAt: string, minutes: number): string {
  return new Date(Date.parse(startsAt) + boundedDuration(minutes) * 60_000).toISOString();
}

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name) as { name: unknown } | undefined;
  return row?.name === name;
}

function eventRow(
  db: Db,
  workspaceId: string,
  eventId: string,
): { readonly startsAt: string; readonly endsAt: string } {
  const row = db
    .prepare(
      `SELECT id, workspace_id, starts_at, ends_at
       FROM events
       WHERE workspace_id = ? AND id = ?
       LIMIT 1`,
    )
    .get(workspaceId, eventId) as
    | { id: unknown; workspace_id: unknown; starts_at: unknown; ends_at: unknown }
    | undefined;
  if (
    !row ||
    row.id !== eventId ||
    row.workspace_id !== workspaceId ||
    typeof row.starts_at !== "string" ||
    typeof row.ends_at !== "string"
  ) {
    return fail();
  }
  const startsAt = safeInstant(row.starts_at);
  const endsAt = safeInstant(row.ends_at);
  if (Date.parse(startsAt) >= Date.parse(endsAt)) return fail();
  return Object.freeze({ startsAt, endsAt });
}

function canonicalStoredJson(value: unknown): boolean {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 524_288) return false;
  try {
    return canonicalJson(JSON.parse(value) as unknown) === value;
  } catch {
    return false;
  }
}

function acceptedProposalDisplay(input: {
  readonly title: string;
  readonly abstract: string | null;
  readonly format: string | null;
  readonly track: string | null;
}) {
  return Object.freeze({
    schema: CFP_ACCEPTED_PROPOSAL_DISPLAY_SCHEMA,
    title: input.title,
    abstract: input.abstract,
    format: input.format,
    track: input.track,
  });
}

function readProposalLineage(
  db: Db,
  workspaceId: string,
  lineageId: string,
): boolean {
  const row = db.prepare(
    `SELECT id, workspace_id, originating_submission_id, originating_submission_revision_id,
            display_projection_json, created_by_account_id
       FROM proposal_lineages
      WHERE workspace_id = ? AND id = ?
      LIMIT 1`,
  ).get(workspaceId, lineageId) as {
    id: unknown;
    workspace_id: unknown;
    originating_submission_id: unknown;
    originating_submission_revision_id: unknown;
    display_projection_json: unknown;
    created_by_account_id: unknown;
  } | undefined;
  if (!row) return false;
  if (
    row.id !== lineageId ||
    row.workspace_id !== workspaceId ||
    typeof row.created_by_account_id !== "string" ||
    !IDENTIFIER_PATTERN.test(row.created_by_account_id) ||
    !canonicalStoredJson(row.display_projection_json) ||
    (row.originating_submission_id === null) !== (row.originating_submission_revision_id === null)
  ) {
    return fail();
  }
  const actor = db.prepare(
    `SELECT id FROM accounts WHERE workspace_id = ? AND id = ? LIMIT 1`,
  ).get(workspaceId, row.created_by_account_id) as { id: unknown } | undefined;
  if (!actor || actor.id !== row.created_by_account_id) return fail();
  if (row.originating_submission_id !== null) {
    if (
      typeof row.originating_submission_id !== "string" ||
      typeof row.originating_submission_revision_id !== "string" ||
      !IDENTIFIER_PATTERN.test(row.originating_submission_id) ||
      !IDENTIFIER_PATTERN.test(row.originating_submission_revision_id)
    ) {
      return fail();
    }
    const origin = db.prepare(
      `SELECT 1
         FROM submissions submission
         JOIN submission_revisions revision
           ON revision.workspace_id = submission.workspace_id
          AND revision.submission_id = submission.id
          AND revision.id = ?
        WHERE submission.workspace_id = ? AND submission.id = ?
        LIMIT 1`,
    ).get(row.originating_submission_revision_id, workspaceId, row.originating_submission_id);
    if (!origin) return fail();
  }
  return true;
}

function authorizedLineageActor(
  db: Db,
  workspaceId: string,
  actor: ProposalLineageActor,
): ProposalLineageActor {
  const normalized = Object.freeze({
    workspaceId: identifier(actor.workspaceId),
    workspaceSlug: identifier(actor.workspaceSlug),
    accountId: identifier(actor.accountId),
    role: identifier(actor.role),
  });
  if (normalized.workspaceId !== workspaceId || !roleHasCapability(normalized.role, "phase0.pipeline.manage")) {
    return fail();
  }
  const persisted = db.prepare(
    `SELECT account.id, account.workspace_id, account.role, workspace.slug
       FROM accounts account
       JOIN workspaces workspace ON workspace.id = account.workspace_id
      WHERE account.workspace_id = ? AND account.id = ?
      LIMIT 1`,
  ).get(workspaceId, normalized.accountId) as {
    id: unknown;
    workspace_id: unknown;
    role: unknown;
    slug: unknown;
  } | undefined;
  if (
    !persisted ||
    persisted.id !== normalized.accountId ||
    persisted.workspace_id !== workspaceId ||
    persisted.role !== normalized.role ||
    persisted.slug !== normalized.workspaceSlug
  ) {
    return fail();
  }
  return normalized;
}

function readAcceptedRevisionBinding(
  db: Db,
  input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly submissionId: string;
    readonly revisionId: string;
    readonly revisionFingerprint: string;
    readonly speakerPersonId: string;
    readonly requireCurrentRevision: boolean;
  },
): {
  readonly lineageId: string | null;
  readonly state: "DRAFT" | "SUBMITTED" | "WITHDRAWN" | "INVALIDATED";
} {
  const row = db.prepare(
    `SELECT submission.id, submission.workspace_id, submission.event_id, submission.state,
            submission.current_revision_id, submission.owner_person_id, submission.lineage_id,
            revision.id AS revision_id, revision.fingerprint_algorithm, revision.fingerprint
       FROM submissions submission
       JOIN submission_revisions revision
         ON revision.workspace_id = submission.workspace_id
        AND revision.submission_id = submission.id
        AND revision.id = ?
      WHERE submission.workspace_id = ? AND submission.id = ?
      LIMIT 1`,
  ).get(input.revisionId, input.workspaceId, input.submissionId) as Record<string, unknown> | undefined;
  if (
    !row ||
    row.id !== input.submissionId ||
    row.workspace_id !== input.workspaceId ||
    row.event_id !== input.eventId ||
    (row.state !== "DRAFT" && row.state !== "SUBMITTED" && row.state !== "WITHDRAWN" && row.state !== "INVALIDATED") ||
    (input.requireCurrentRevision && row.current_revision_id !== input.revisionId) ||
    row.owner_person_id !== input.speakerPersonId ||
    row.revision_id !== input.revisionId ||
    row.fingerprint_algorithm !== "sha256-canonical-json-v1" ||
    row.fingerprint !== input.revisionFingerprint ||
    (row.lineage_id !== null && (typeof row.lineage_id !== "string" || !IDENTIFIER_PATTERN.test(row.lineage_id)))
  ) {
    return fail();
  }
  return Object.freeze({
    lineageId: row.lineage_id as string | null,
    state: row.state as "DRAFT" | "SUBMITTED" | "WITHDRAWN" | "INVALIDATED",
  });
}

function ensureProposalLineage(
  db: Db,
  input: Readonly<{
    workspaceId: string;
    eventId: string;
    submissionId: string;
    revisionId: string;
    revisionFingerprint: string;
    speakerPersonId: string;
    actor: ProposalLineageActor;
    title: string;
    abstract: string | null;
    format: string | null;
    track: string | null;
    createdAt: string;
  }>,
): string {
  const actor = authorizedLineageActor(db, input.workspaceId, input.actor);
  const binding = readAcceptedRevisionBinding(db, { ...input, requireCurrentRevision: true });
  if (binding.state !== "SUBMITTED") return fail();
  const displayProjection = acceptedProposalDisplay(input);
  if (binding.lineageId !== null) {
    if (!readProposalLineage(db, input.workspaceId, binding.lineageId)) return fail();
    return binding.lineageId;
  }

  const idempotencySuffix = deterministicUuid(
    `cfp-accepted-lineage:${input.workspaceId}:${input.submissionId}:${input.revisionId}:${input.revisionFingerprint}`,
  );
  try {
    const created = createProposalLineage(db, actor, {
      workspaceSlug: actor.workspaceSlug,
      submissionId: input.submissionId,
      submissionRevisionId: input.revisionId,
      displayProjection,
      idempotencyKey: `cfp-accepted-lineage-${idempotencySuffix}`,
      expectedSubmissionCurrentRevisionId: input.revisionId,
    });
    const bound = bindSubmissionToLineage(db, actor, {
      workspaceSlug: actor.workspaceSlug,
      submissionId: input.submissionId,
      lineageId: created.lineageId,
      expectedLineageId: null,
      idempotencyKey: `cfp-accepted-bind-${idempotencySuffix}`,
      expectedCurrentRevisionId: input.revisionId,
    });
    if (bound.lineageId !== created.lineageId) return fail();
  } catch {
    return fail();
  }
  const persisted = readAcceptedRevisionBinding(db, { ...input, requireCurrentRevision: true });
  if (persisted.lineageId === null || !readProposalLineage(db, input.workspaceId, persisted.lineageId)) {
    return fail();
  }
  return persisted.lineageId;
}

interface ProgramUnitAuthority {
  readonly name: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly capacity: number;
}

interface TrackAuthority {
  readonly id: string;
  readonly name: string;
  readonly proposalTrack: string | null;
  readonly source: CfpSessionTrackSource;
}

function programUnitStorageName(programUnitId: string): string {
  return `CFP session ${programUnitId}`;
}

function readProgramUnit(
  db: Db,
  workspaceId: string,
  eventId: string,
  programUnitId: string,
  expected: ProgramUnitAuthority,
): boolean {
  const row = db
    .prepare(
      `SELECT id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity
       FROM program_units
       WHERE workspace_id = ? AND id = ?
       LIMIT 1`,
    )
    .get(workspaceId, programUnitId) as
    | {
        id: unknown;
        workspace_id: unknown;
        event_id: unknown;
        name: unknown;
        unit_type: unknown;
        starts_at: unknown;
        ends_at: unknown;
        capacity: unknown;
      }
    | undefined;
  if (!row) return false;
  if (
    row.id !== programUnitId ||
    row.workspace_id !== workspaceId ||
    row.event_id !== eventId ||
    row.name !== expected.name ||
    row.unit_type !== "session" ||
    row.starts_at !== expected.startsAt ||
    row.ends_at !== expected.endsAt ||
    row.capacity !== expected.capacity ||
    safeInstant(row.starts_at) !== expected.startsAt ||
    safeInstant(row.ends_at) !== expected.endsAt ||
    Date.parse(expected.startsAt) >= Date.parse(expected.endsAt)
  ) {
    return fail();
  }
  return true;
}

function resolvedDuration(
  input: Pick<EnsureCfpSessionHandoffInput, "requestedDurationMinutes" | "requestedDurationSource">,
  event: { readonly startsAt: string; readonly endsAt: string },
): {
  readonly durationMinutes: number;
  readonly durationSource: CfpSessionDurationSource;
  readonly startsAt: string;
  readonly endsAt: string;
} {
  if ((input.requestedDurationMinutes === null) !== (input.requestedDurationSource === null)) {
    return fail();
  }
  const eventMinutes = Math.floor((Date.parse(event.endsAt) - Date.parse(event.startsAt)) / 60_000);
  if (!Number.isSafeInteger(eventMinutes) || eventMinutes < 1) return fail();
  const durationMinutes = input.requestedDurationMinutes === null
    ? Math.min(CFP_SESSION_DEFAULT_DURATION_MINUTES, eventMinutes)
    : boundedDuration(input.requestedDurationMinutes);
  if (durationMinutes > eventMinutes) return fail();
  const durationSource = input.requestedDurationSource ?? "CANONICAL_DEFAULT";
  const endsAt = addMinutes(event.startsAt, durationMinutes);
  if (Date.parse(endsAt) > Date.parse(event.endsAt)) return fail();
  return Object.freeze({
    durationMinutes,
    durationSource,
    startsAt: event.startsAt,
    endsAt,
  });
}

function matchingTrackRows(
  db: Db,
  workspaceId: string,
  eventId: string,
  value: string,
): Array<{ readonly id: unknown; readonly name: unknown; readonly slug: unknown }> {
  return db.prepare(
    `SELECT id, name, slug
       FROM event_tracks
      WHERE workspace_id = ? AND event_id = ?
        AND (id = ? OR name = ? OR slug = ?)
      ORDER BY id
      LIMIT 3`,
  ).all(workspaceId, eventId, value, value, value) as Array<{
    readonly id: unknown;
    readonly name: unknown;
    readonly slug: unknown;
  }>;
}

function validatedTrackRow(
  rows: ReturnType<typeof matchingTrackRows>,
): { readonly id: string; readonly name: string } | null {
  if (rows.length > 1) return fail();
  const row = rows[0];
  if (!row) return null;
  const id = identifier(row.id);
  const name = safeText(row.name);
  identifier(row.slug);
  return Object.freeze({ id, name });
}

function deterministicTrackAuthority(
  workspaceId: string,
  eventId: string,
  proposalTrack: string | null,
): TrackAuthority {
  if (proposalTrack === null) {
    return Object.freeze({
      id: deterministicUuid(`cfp-fallback-track:${workspaceId}:${eventId}`),
      name: CFP_FALLBACK_TRACK_NAME,
      proposalTrack: null,
      source: "CANONICAL_FALLBACK",
    });
  }
  return Object.freeze({
    id: deterministicUuid(`cfp-proposal-track:${workspaceId}:${eventId}:${fingerprintOf(proposalTrack)}`),
    name: proposalTrack,
    proposalTrack,
    source: "PROPOSAL",
  });
}

function resolveTrackAuthority(
  db: Db,
  input: Pick<EnsureCfpSessionHandoffInput, "workspaceId" | "eventId" | "track" | "trackRequired" | "createdAt">,
  persist: boolean,
): TrackAuthority {
  if (input.trackRequired && input.track === null) return fail();
  const desired = deterministicTrackAuthority(input.workspaceId, input.eventId, input.track);
  if (input.track !== null) {
    const exact = validatedTrackRow(matchingTrackRows(db, input.workspaceId, input.eventId, input.track));
    if (exact) {
      return Object.freeze({
        id: exact.id,
        name: exact.name,
        proposalTrack: input.track,
        source: "PROPOSAL",
      });
    }
  } else {
    const existingFallback = validatedTrackRow(
      matchingTrackRows(db, input.workspaceId, input.eventId, desired.id),
    );
    if (existingFallback) {
      if (existingFallback.id !== desired.id || existingFallback.name !== desired.name) return fail();
      return desired;
    }
    const conflictingName = validatedTrackRow(
      matchingTrackRows(db, input.workspaceId, input.eventId, desired.name),
    );
    if (conflictingName) return fail();
  }
  if (!persist) return desired;
  try {
    db.prepare(
      `INSERT INTO event_tracks (id, workspace_id, event_id, name, slug, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(desired.id, input.workspaceId, input.eventId, desired.name, desired.id, input.createdAt);
  } catch {
    const replay = validatedTrackRow(
      matchingTrackRows(db, input.workspaceId, input.eventId, desired.id),
    );
    if (!replay || replay.id !== desired.id || replay.name !== desired.name) return fail();
  }
  const stored = validatedTrackRow(matchingTrackRows(db, input.workspaceId, input.eventId, desired.id));
  if (!stored || stored.id !== desired.id || stored.name !== desired.name) return fail();
  return desired;
}

function ensureProgramUnit(
  db: Db,
  input: Readonly<EnsureCfpSessionHandoffInput & { readonly proposalLineageId: string }>,
  authority: Omit<ProgramUnitAuthority, "name">,
): { readonly programUnitId: string; readonly programUnitName: string } {
  const programUnitId = deterministicUuid(
    `cfp-session:${input.workspaceId}:${input.eventId}:${input.proposalLineageId}`,
  );
  const programUnitName = programUnitStorageName(programUnitId);
  const expected = Object.freeze({ ...authority, name: programUnitName });
  if (readProgramUnit(db, input.workspaceId, input.eventId, programUnitId, expected)) {
    return Object.freeze({ programUnitId, programUnitName });
  }

  try {
    db.prepare(
      `INSERT INTO program_units
         (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
       VALUES (?, ?, ?, ?, 'session', ?, ?, ?, ?)`,
    ).run(
      programUnitId,
      input.workspaceId,
      input.eventId,
      programUnitName,
      expected.startsAt,
      expected.endsAt,
      expected.capacity,
      input.createdAt,
    );
  } catch {
    if (readProgramUnit(db, input.workspaceId, input.eventId, programUnitId, expected)) {
      return Object.freeze({ programUnitId, programUnitName });
    }
    return fail();
  }
  if (!readProgramUnit(db, input.workspaceId, input.eventId, programUnitId, expected)) {
    return fail();
  }
  return Object.freeze({ programUnitId, programUnitName });
}

function ensureSpeakerLink(
  db: Db,
  input: EnsureCfpSessionHandoffInput,
): string | null {
  const person = db
    .prepare(
      `SELECT id, workspace_id
       FROM people
       WHERE workspace_id = ? AND id = ?
       LIMIT 1`,
    )
    .get(input.workspaceId, input.speakerPersonId) as { id: unknown; workspace_id: unknown } | undefined;
  if (!person || person.id !== input.speakerPersonId || person.workspace_id !== input.workspaceId) return fail();
  if (!tableExists(db, "event_speakers")) return null;

  const existing = db
    .prepare(
      `SELECT id, workspace_id, event_id, person_id, role_key
       FROM event_speakers
       WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND role_key = 'SPEAKER'
       ORDER BY created_at, id
       LIMIT 2`,
    )
    .all(input.workspaceId, input.eventId, input.speakerPersonId) as Array<{
      id: unknown;
      workspace_id: unknown;
      event_id: unknown;
      person_id: unknown;
      role_key: unknown;
    }>;
  if (existing.length > 1) return fail();
  const first = existing[0];
  if (first) {
    if (
      typeof first.id !== "string" ||
      first.workspace_id !== input.workspaceId ||
      first.event_id !== input.eventId ||
      first.person_id !== input.speakerPersonId ||
      first.role_key !== "SPEAKER"
    ) {
      return fail();
    }
    return first.id;
  }

  const speakerLinkId = deterministicUuid(
    `cfp-speaker-link:${input.workspaceId}:${input.eventId}:${input.speakerPersonId}`,
  );
  try {
    db.prepare(
      `INSERT INTO event_speakers
         (id, workspace_id, event_id, person_id, role_key, participation_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'SPEAKER', 'INVITED', ?, ?)`,
    ).run(
      speakerLinkId,
      input.workspaceId,
      input.eventId,
      input.speakerPersonId,
      input.createdAt,
      input.createdAt,
    );
  } catch {
    const replay = db
      .prepare(
        `SELECT id, workspace_id, event_id, person_id, role_key
         FROM event_speakers
         WHERE workspace_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(input.workspaceId, speakerLinkId) as
      | {
          id: unknown;
          workspace_id: unknown;
          event_id: unknown;
          person_id: unknown;
          role_key: unknown;
        }
      | undefined;
    if (
      replay &&
      replay.id === speakerLinkId &&
      replay.workspace_id === input.workspaceId &&
      replay.event_id === input.eventId &&
      replay.person_id === input.speakerPersonId &&
      replay.role_key === "SPEAKER"
    ) {
      return speakerLinkId;
    }
    return fail();
  }
  return speakerLinkId;
}

function currentSessionPlacement(
  db: Db,
  workspaceId: string,
  eventId: string,
  programUnitId: string,
  event: { readonly startsAt: string; readonly endsAt: string },
  durationMinutes: number,
): CfpSessionPlacementProjection | null {
  if (!tableExists(db, "event_session_allocations")) return null;
  const rows = db
    .prepare(
      `SELECT allocation.id, allocation.workspace_id, allocation.event_id,
              allocation.program_unit_id, allocation.room_id, allocation.track_id,
              allocation.starts_at, allocation.ends_at, allocation.allocation_status,
              room.name AS room_name, track.name AS track_name
         FROM event_session_allocations allocation
         JOIN event_rooms room
           ON room.workspace_id = allocation.workspace_id
          AND room.event_id = allocation.event_id
          AND room.id = allocation.room_id
         LEFT JOIN event_tracks track
           ON track.workspace_id = allocation.workspace_id
          AND track.event_id = allocation.event_id
          AND track.id = allocation.track_id
        WHERE allocation.workspace_id = ? AND allocation.event_id = ?
          AND allocation.program_unit_id = ?
          AND allocation.allocation_status <> 'CANCELLED'
        ORDER BY allocation.rowid
        LIMIT 2`,
    )
    .all(workspaceId, eventId, programUnitId) as Array<Record<string, unknown>>;
  if (rows.length > 1) return fail();
  const row = rows[0];
  if (!row) return null;
  const roomId = identifier(row.room_id);
  const trackId = identifier(row.track_id);
  const startsAt = safeInstant(row.starts_at);
  const endsAt = safeInstant(row.ends_at);
  if (
    row.workspace_id !== workspaceId ||
    row.event_id !== eventId ||
    row.program_unit_id !== programUnitId ||
    row.allocation_status !== "DRAFT" && row.allocation_status !== "PUBLISHED" ||
    Date.parse(startsAt) < Date.parse(event.startsAt) ||
    Date.parse(endsAt) > Date.parse(event.endsAt) ||
    Date.parse(endsAt) - Date.parse(startsAt) !== boundedDuration(durationMinutes) * 60_000
  ) {
    return fail();
  }
  return Object.freeze({
    roomId,
    roomName: safeText(row.room_name, 120),
    trackId,
    trackName: safeText(row.track_name, 120),
    startsAt,
    endsAt,
  });
}

function scopedProgramUnitExists(
  db: Db,
  workspaceId: string,
  eventId: string,
  programUnitId: string,
): boolean {
  const row = db.prepare(
    `SELECT id, workspace_id, event_id, unit_type
       FROM program_units
      WHERE workspace_id = ? AND event_id = ? AND id = ?
      LIMIT 1`,
  ).get(workspaceId, eventId, programUnitId) as Record<string, unknown> | undefined;
  return Boolean(
    row &&
    row.id === programUnitId &&
    row.workspace_id === workspaceId &&
    row.event_id === eventId &&
    row.unit_type === "session",
  );
}

export function ensureAcceptedCfpSession(
  db: Db,
  rawInput: EnsureCfpSessionHandoffInput,
): CfpSessionHandoffEvidence {
  if (typeof rawInput.trackRequired !== "boolean") return fail();
  const input = Object.freeze({
    workspaceId: identifier(rawInput.workspaceId),
    eventId: identifier(rawInput.eventId),
    submissionId: identifier(rawInput.submissionId),
    revisionId: identifier(rawInput.revisionId),
    revisionFingerprint: fingerprint(rawInput.revisionFingerprint),
    speakerPersonId: identifier(rawInput.speakerPersonId),
    actor: rawInput.actor,
    title: safeText(rawInput.title, 240),
    abstract: optionalSafeText(rawInput.abstract, 4_000),
    format: optionalSafeText(rawInput.format, 120),
    track: optionalSafeText(rawInput.track, 120),
    trackRequired: rawInput.trackRequired === true,
    requestedDurationMinutes: rawInput.requestedDurationMinutes === null
      ? null
      : boundedDuration(rawInput.requestedDurationMinutes),
    requestedDurationSource: rawInput.requestedDurationSource,
    createdAt: safeInstant(rawInput.createdAt),
  });
  if (
    input.requestedDurationSource !== null &&
    input.requestedDurationSource !== "PROPOSAL_ANSWER" &&
    input.requestedDurationSource !== "FORMAT_OPTION"
  ) {
    return fail();
  }
  return withTransactionOrSavepoint(db, "cfp_accept_session_handoff", () => {
    const event = eventRow(db, input.workspaceId, input.eventId);
    const duration = resolvedDuration(input, event);
    const track = resolveTrackAuthority(db, input, true);
    const proposalLineageId = ensureProposalLineage(db, input);
    const unit = ensureProgramUnit(db, { ...input, proposalLineageId }, {
      startsAt: duration.startsAt,
      endsAt: duration.endsAt,
      capacity: CFP_SESSION_MINIMUM_CAPACITY,
    });
    const speakerLinkId = ensureSpeakerLink(db, input);
    return Object.freeze({
      schema: CFP_SESSION_HANDOFF_SCHEMA,
      eventId: input.eventId,
      programUnitId: unit.programUnitId,
      programUnitName: unit.programUnitName,
      proposalLineageId,
      sourceSubmissionId: input.submissionId,
      sourceRevisionId: input.revisionId,
      sourceRevisionFingerprint: input.revisionFingerprint,
      speakerPersonId: input.speakerPersonId,
      speakerLinkId,
      capacity: CFP_SESSION_MINIMUM_CAPACITY,
      format: input.format,
      durationMinutes: duration.durationMinutes,
      durationSource: duration.durationSource,
      startsAt: duration.startsAt,
      endsAt: duration.endsAt,
      proposalTrack: track.proposalTrack,
      trackId: track.id,
      trackName: track.name,
      trackSource: track.source,
      createdStatus: CFP_SESSION_HANDOFF_CREATED_STATUS,
    });
  });
}

export function readCfpSessionHandoff(
  db: Db,
  input: {
    readonly workspaceId: string;
    readonly evidence: ReadableCfpSessionHandoffEvidence;
    readonly title: string;
    readonly format: string | null;
    readonly track: string | null;
    readonly trackRequired: boolean;
    readonly requestedDurationMinutes: number | null;
    readonly requestedDurationSource: Exclude<CfpSessionDurationSource, "CANONICAL_DEFAULT"> | null;
    readonly authorityMode?: "CURRENT" | "HISTORICAL";
  },
): CfpSessionHandoffProjection {
  const workspaceId = identifier(input.workspaceId);
  const evidence = input.evidence;
  if (evidence.createdStatus !== CFP_SESSION_HANDOFF_CREATED_STATUS) {
    return fail();
  }
  const legacy = evidence.schema === LEGACY_CFP_SESSION_HANDOFF_SCHEMA;
  const lineageV2 = evidence.schema === LINEAGE_CFP_SESSION_HANDOFF_SCHEMA;
  if (!legacy && !lineageV2 && evidence.schema !== CFP_SESSION_HANDOFF_SCHEMA) return fail();
  const eventId = identifier(evidence.eventId);
  const programUnitId = identifier(evidence.programUnitId);
  const proposalLineageId = legacy ? null : identifier(evidence.proposalLineageId);
  const sourceSubmissionId = identifier(evidence.sourceSubmissionId);
  const sourceRevisionId = identifier(evidence.sourceRevisionId);
  const sourceRevisionFingerprint = fingerprint(evidence.sourceRevisionFingerprint);
  const speakerPersonId = identifier(evidence.speakerPersonId);
  const speakerLinkId = evidence.speakerLinkId === null ? null : identifier(evidence.speakerLinkId);
  const title = safeText(input.title, 240);
  const format = optionalSafeText(input.format, 120);
  const proposalTrack = optionalSafeText(input.track, 120);
  const authorityMode = input.authorityMode ?? "CURRENT";
  if (input.trackRequired && proposalTrack === null) return fail();
  const event = eventRow(db, workspaceId, eventId);
  let duration: ReturnType<typeof resolvedDuration>;
  let track: TrackAuthority;
  let storedUnit: ProgramUnitAuthority;
  if (evidence.schema === CFP_SESSION_HANDOFF_SCHEMA) {
    const durationMinutes = boundedDuration(evidence.durationMinutes);
    const durationSource = evidence.durationSource;
    const startsAt = safeInstant(evidence.startsAt);
    const endsAt = safeInstant(evidence.endsAt);
    const expectedDuration = authorityMode === "CURRENT"
      ? resolvedDuration({
          requestedDurationMinutes: input.requestedDurationMinutes,
          requestedDurationSource: input.requestedDurationSource,
        }, event)
      : null;
    const expectedTrack = authorityMode === "CURRENT"
      ? resolveTrackAuthority(db, {
          workspaceId,
          eventId,
          track: proposalTrack,
          trackRequired: input.trackRequired,
          createdAt: event.startsAt,
        }, false)
      : null;
    if (
      evidence.capacity !== CFP_SESSION_MINIMUM_CAPACITY ||
      evidence.format !== format ||
      (expectedDuration !== null && durationMinutes !== expectedDuration.durationMinutes) ||
      (expectedDuration !== null && durationSource !== expectedDuration.durationSource) ||
      (authorityMode === "HISTORICAL" && input.requestedDurationMinutes !== null &&
        durationMinutes !== input.requestedDurationMinutes) ||
      (authorityMode === "HISTORICAL" && input.requestedDurationSource !== null &&
        durationSource !== input.requestedDurationSource) ||
      (authorityMode === "HISTORICAL" && input.requestedDurationMinutes === null &&
        durationSource !== "CANONICAL_DEFAULT") ||
      (durationSource !== "PROPOSAL_ANSWER" &&
        durationSource !== "FORMAT_OPTION" &&
        durationSource !== "CANONICAL_DEFAULT") ||
      (expectedDuration !== null && startsAt !== expectedDuration.startsAt) ||
      (expectedDuration !== null && endsAt !== expectedDuration.endsAt) ||
      Date.parse(endsAt) - Date.parse(startsAt) !== durationMinutes * 60_000 ||
      (authorityMode === "CURRENT" && Date.parse(endsAt) > Date.parse(event.endsAt)) ||
      evidence.proposalTrack !== proposalTrack ||
      (evidence.trackSource !== "PROPOSAL" && evidence.trackSource !== "CANONICAL_FALLBACK") ||
      (proposalTrack === null) !== (evidence.trackSource === "CANONICAL_FALLBACK") ||
      (expectedTrack !== null && evidence.trackId !== expectedTrack.id) ||
      (expectedTrack !== null && evidence.trackName !== expectedTrack.name) ||
      (expectedTrack !== null && evidence.trackSource !== expectedTrack.source)
    ) {
      return fail();
    }
    duration = Object.freeze({ durationMinutes, durationSource, startsAt, endsAt });
    track = Object.freeze({
      id: identifier(evidence.trackId),
      name: safeText(evidence.trackName, 120),
      proposalTrack,
      source: evidence.trackSource,
    });
    if (authorityMode === "CURRENT") {
      const storedTrack = validatedTrackRow(matchingTrackRows(db, workspaceId, eventId, track.id));
      if (!storedTrack || storedTrack.id !== track.id || storedTrack.name !== track.name) return fail();
    }
    storedUnit = Object.freeze({
      name: safeText(evidence.programUnitName, 160),
      startsAt,
      endsAt,
      capacity: CFP_SESSION_MINIMUM_CAPACITY,
    });
    if (storedUnit.name !== programUnitStorageName(programUnitId)) return fail();
  } else {
    if (authorityMode === "HISTORICAL") return fail();
    duration = resolvedDuration({
      requestedDurationMinutes: input.requestedDurationMinutes,
      requestedDurationSource: input.requestedDurationSource,
    }, event);
    track = resolveTrackAuthority(db, {
      workspaceId,
      eventId,
      track: proposalTrack,
      trackRequired: input.trackRequired,
      createdAt: event.startsAt,
    }, false);
    storedUnit = Object.freeze({
      name: title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      capacity: legacy ? 0 : CFP_SESSION_MINIMUM_CAPACITY,
    });
    if (lineageV2 && evidence.capacity !== CFP_SESSION_MINIMUM_CAPACITY) return fail();
  }
  if (
    authorityMode === "CURRENT"
      ? !readProgramUnit(db, workspaceId, eventId, programUnitId, storedUnit)
      : !scopedProgramUnitExists(db, workspaceId, eventId, programUnitId)
  ) return fail();

  if (!legacy) {
    if (proposalLineageId === null) return fail();
    const binding = readAcceptedRevisionBinding(db, {
      workspaceId,
      eventId,
      submissionId: sourceSubmissionId,
      revisionId: sourceRevisionId,
      revisionFingerprint: sourceRevisionFingerprint,
      speakerPersonId,
      requireCurrentRevision: authorityMode === "CURRENT",
    });
    if (
      binding.lineageId !== proposalLineageId ||
      !readProposalLineage(db, workspaceId, proposalLineageId)
    ) {
      return fail();
    }
  }

  const speakerTableAvailable = tableExists(db, "event_speakers");
  if (!speakerTableAvailable && speakerLinkId !== null) return fail();
  if (speakerTableAvailable) {
    const person = db
      .prepare(
        `SELECT id, workspace_id
         FROM people
         WHERE workspace_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(workspaceId, speakerPersonId) as { id: unknown; workspace_id: unknown } | undefined;
    if (!person || person.id !== speakerPersonId || person.workspace_id !== workspaceId) return fail();
    if (speakerLinkId === null) return fail();
  }

  if (speakerLinkId !== null) {
    const speaker = db
      .prepare(
        `SELECT id, workspace_id, event_id, person_id, role_key
         FROM event_speakers
         WHERE workspace_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(workspaceId, speakerLinkId) as
      | {
          id: unknown;
          workspace_id: unknown;
          event_id: unknown;
          person_id: unknown;
          role_key: unknown;
        }
      | undefined;
    if (
      !speaker ||
      speaker.id !== speakerLinkId ||
      speaker.workspace_id !== workspaceId ||
      speaker.event_id !== eventId ||
      speaker.person_id !== speakerPersonId ||
      speaker.role_key !== "SPEAKER"
    ) {
      return fail();
    }
  }

  const draftPlacement = authorityMode === "CURRENT"
    ? currentSessionPlacement(
        db,
        workspaceId,
        eventId,
        programUnitId,
        event,
        duration.durationMinutes,
      )
    : null;

  return Object.freeze({
    eventId,
    programUnitId,
    proposalLineageId,
    sourceSubmissionId,
    sourceRevisionId,
    sourceRevisionFingerprint,
    speakerPersonId,
    speakerLinkId,
    name: title,
    unitType: "session",
    startsAt: duration.startsAt,
    endsAt: duration.endsAt,
    capacity: CFP_SESSION_MINIMUM_CAPACITY,
    format,
    durationMinutes: duration.durationMinutes,
    durationSource: duration.durationSource,
    proposalTrack,
    trackId: track.id,
    trackName: track.name,
    trackSource: track.source,
    status: draftPlacement ? "DRAFT_UNPUBLISHED" : "UNSCHEDULED",
    placement: null,
    release: null,
  });
}
