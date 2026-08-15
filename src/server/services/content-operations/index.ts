import { canonicalJson, fingerprintOf, nowIso, deterministicUuid } from "../../canonical";
import { withTransactionOrSavepoint, type Db } from "../../db";
import { readAcceptedCurrentPlanAssignmentId } from "../evaluator-speaker-identity";

export const CONTENT_OPERATIONS_SCHEMA = "sympose-content-operations/v1" as const;

export const CONTENT_KINDS = [
  "PROFILE",
  "BIO",
  "SESSION_TITLE",
  "SESSION_DESCRIPTION",
  "SOCIAL_LINKS",
  "HEADSHOT",
  "SLIDES",
  "LOGISTICS",
  "ACKNOWLEDGEMENT",
] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const CONTENT_REVIEW_STATES = [
  "SUBMITTED",
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "BLOCKED",
  "APPROVED",
  "SUPERSEDED",
] as const;
export type ContentReviewState = (typeof CONTENT_REVIEW_STATES)[number];

export const CONTENT_SEVERITIES = ["INFO", "WARNING", "BLOCKER"] as const;
export type ContentFindingSeverity = (typeof CONTENT_SEVERITIES)[number];

export const CONTENT_VALIDATION_CONTRACT = Object.freeze({
  schema: "content-validation/v1",
  textBytes: 12000,
  commentBytes: 2400,
  revisionReasonBytes: 1600,
  bioBytes: 12000,
  sessionTitleBytes: 240,
  sessionDescriptionBytes: 12000,
  headshotBytes: 8 * 1024 * 1024,
  slideBytes: 25 * 1024 * 1024,
  headshotMediaTypes: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
  slideMediaTypes: Object.freeze(["application/pdf", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]),
});

export class ContentOperationsInputError extends Error {
  readonly code = "INVALID_CONTENT_OPERATION_INPUT" as const;

  constructor(message = "Content operation input is invalid.") {
    super(message);
    this.name = "ContentOperationsInputError";
  }
}

export class ContentOperationsAuthorizationError extends Error {
  readonly code = "CONTENT_OPERATION_NOT_AUTHORIZED" as const;

  constructor(message = "Content operation is not authorized for this scope.") {
    super(message);
    this.name = "ContentOperationsAuthorizationError";
  }
}

export class ContentOperationsConflictError extends Error {
  readonly code = "CONTENT_OPERATION_CONFLICT" as const;

  constructor(message = "Content operation conflicts with the current immutable history.") {
    super(message);
    this.name = "ContentOperationsConflictError";
  }
}

export type ContentActorKind = "organizer" | "speaker";

export interface ContentOperationsScope {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly actorId: string;
  readonly actorKind: ContentActorKind;
  /** Required for speaker scope; organizer scope may review any Person in the event. */
  readonly personId?: string;
}

export interface SocialLink {
  readonly label: string;
  readonly url: string;
}

export interface ContentAssetMetadata {
  readonly assetId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly checksum: string;
  /** A scoped local artifact reference; provider adapters remain a separate integration boundary. */
  readonly storageRef: `synthetic://${string}`;
}

export type ContentPayload =
  | {
      readonly kind: "PROFILE";
      readonly bio: string;
      readonly publicTitle: string;
      readonly organization: string;
      readonly socialLinks: readonly SocialLink[];
      readonly headshot: ContentAssetMetadata | null;
    }
  | { readonly kind: "BIO"; readonly bio: string }
  | { readonly kind: "SESSION_TITLE"; readonly title: string }
  | { readonly kind: "SESSION_DESCRIPTION"; readonly description: string }
  | { readonly kind: "SOCIAL_LINKS"; readonly links: readonly SocialLink[] }
  | { readonly kind: "HEADSHOT"; readonly asset: ContentAssetMetadata }
  | { readonly kind: "SLIDES"; readonly asset: ContentAssetMetadata }
  | {
      readonly kind: "LOGISTICS";
      readonly arrivalWindow: string;
      readonly travelMode: "LOCAL" | "TRAIN" | "AIR" | "REMOTE" | "UNKNOWN";
      readonly dietaryNotes: string;
    }
  | { readonly kind: "ACKNOWLEDGEMENT"; readonly statementId: string; readonly acknowledged: true };

export interface ContentSubmissionVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly taskId: string;
  readonly kind: ContentKind;
  readonly version: number;
  readonly supersedesVersionId: string | null;
  readonly payload: ContentPayload;
  readonly contentHash: string;
  readonly payloadBytes: number;
  readonly submittedAt: string;
  readonly submittedBy: string;
  readonly submittedByKind: ContentActorKind;
  /** Immutable evidence that the payload is local synthetic metadata, not a provider file. */
  readonly source: "synthetic-local-projection" | "local-artifact-store";
}

export interface ContentComment {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly taskId: string;
  readonly submissionVersionId: string;
  readonly submissionContentHash: string;
  readonly body: string;
  readonly authorId: string;
  readonly authorKind: ContentActorKind;
  readonly createdAt: string;
}

export interface ContentFinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly taskId: string;
  readonly submissionVersionId: string;
  readonly submissionContentHash: string;
  readonly severity: ContentFindingSeverity;
  readonly message: string;
  readonly blocksReadiness: boolean;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ContentRevisionRequest {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly taskId: string;
  readonly submissionVersionId: string;
  readonly submissionContentHash: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly createdAt: string;
}

export interface ContentApproval {
  readonly id: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly taskId: string;
  readonly submissionVersionId: string;
  readonly submissionContentHash: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly gate: "CONFIRMATION" | "PUBLICATION" | "OPERATOR_RELEASE";
}

export interface ContentVersionView extends ContentSubmissionVersion {
  readonly reviewState: ContentReviewState;
}

export interface ContentReviewProjection {
  readonly schema: typeof CONTENT_OPERATIONS_SCHEMA;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly personId: string;
  readonly taskId: string;
  readonly kind: ContentKind;
  readonly versions: readonly ContentVersionView[];
  readonly latestVersionId: string | null;
  readonly latestReviewState: ContentReviewState | "NOT_SUBMITTED";
  readonly comments: readonly ContentComment[];
  readonly findings: readonly ContentFinding[];
  readonly revisionRequests: readonly ContentRevisionRequest[];
  readonly approvals: readonly ContentApproval[];
}

/**
 * A publication requirement is deliberately a reference to one exact content
 * task.  Publication never infers readiness from a speaker's aggregate status
 * or from the presence of a latest version alone.
 */
export interface ContentPublicationRequirement {
  readonly id: string;
  readonly label: string;
  readonly personId: string;
  readonly taskId: string;
  readonly kind: ContentKind;
  readonly required: true;
}

export type ContentPublicationItemStatus = "APPROVED" | "PENDING" | "REJECTED";

export interface ContentPublicationItemFact {
  readonly requirement: ContentPublicationRequirement;
  readonly status: ContentPublicationItemStatus;
  readonly currentReviewState: ContentReviewState | "NOT_SUBMITTED";
  readonly currentVersionId: string | null;
  readonly currentContentHash: string | null;
  readonly approvedVersionId: string | null;
  readonly approvedContentHash: string | null;
  readonly approvedPayload: ContentPayload | null;
}

export interface ContentPublicationGate {
  readonly schema: "content-publication-gate/v1";
  readonly workspaceId: string;
  readonly eventId: string;
  readonly state: "READY" | "BLOCKED";
  readonly items: readonly ContentPublicationItemFact[];
  readonly blockers: readonly string[];
  readonly fingerprint: string;
  readonly source: "content-operations-exact-current-version";
}

export interface SubmitContentVersionInput {
  readonly personId: string;
  readonly taskId: string;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
}

export interface AddContentCommentInput {
  readonly personId: string;
  readonly taskId: string;
  readonly submissionVersionId: string;
  readonly submissionContentHash: string;
  readonly body: string;
  readonly idempotencyKey?: string;
}

export interface AddContentFindingInput {
  readonly personId: string;
  readonly taskId: string;
  readonly submissionVersionId: string;
  readonly submissionContentHash: string;
  readonly severity: ContentFindingSeverity;
  readonly message: string;
  readonly blocksReadiness?: boolean;
  readonly idempotencyKey?: string;
}

export interface RequestContentRevisionInput {
  readonly personId: string;
  readonly taskId: string;
  readonly submissionVersionId: string;
  readonly submissionContentHash: string;
  readonly reason: string;
  readonly idempotencyKey?: string;
}

export interface ApproveContentVersionInput {
  readonly personId: string;
  readonly taskId: string;
  readonly submissionVersionId: string;
  readonly submissionContentHash: string;
  readonly gate?: ContentApproval["gate"];
  readonly idempotencyKey?: string;
}

export interface RestoreContentVersionInput {
  readonly personId: string;
  readonly taskId: string;
  readonly submissionVersionId: string;
  readonly submissionContentHash: string;
  readonly idempotencyKey?: string;
}

export interface ContentOperationsRepository {
  readonly schema: typeof CONTENT_OPERATIONS_SCHEMA;
  getReviewProjection(scope: ContentOperationsScope, target: { readonly personId: string; readonly taskId: string; readonly kind: ContentKind }): ContentReviewProjection;
  submitVersion(scope: ContentOperationsScope, input: SubmitContentVersionInput): ContentSubmissionVersion;
  /** Compensates only an unpublished version created by the enclosing atomic boundary. */
  readonly rollbackUnpublishedVersion?: (version: ContentSubmissionVersion) => void;
  addComment(scope: ContentOperationsScope, input: AddContentCommentInput): ContentComment;
  addFinding(scope: ContentOperationsScope, input: AddContentFindingInput): ContentFinding;
  requestRevision(scope: ContentOperationsScope, input: RequestContentRevisionInput): ContentRevisionRequest;
  approveVersion(scope: ContentOperationsScope, input: ApproveContentVersionInput): ContentApproval;
  restoreVersion(scope: ContentOperationsScope, input: RestoreContentVersionInput): ContentSubmissionVersion;
}

type Clock = () => string;

const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[^\u0000-\u001f\u007f-\u009f]{1,160}$/u;
const SAFE_FILENAME = /^[^/\\\u0000-\u001f\u007f-\u009f]{1,180}$/u;
const SAFE_TEXT = /[\u0000-\u001f\u007f-\u009f]/u;

function fail(message: string): never {
  throw new ContentOperationsInputError(message);
}

function conflict(message: string): never {
  throw new ContentOperationsConflictError(message);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("Content payload must be a plain object.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    fail("Content payload contains an unsupported field.");
  }
}

function text(value: unknown, maxBytes: number, field: string): string {
  if (typeof value !== "string" || value.length < 1 || SAFE_TEXT.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(`${field} is invalid or exceeds its bounded size.`);
  }
  return value;
}

function optionalText(value: unknown, maxBytes: number, field: string): string {
  if (value === "") return "";
  return text(value, maxBytes, field);
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${field} is invalid.`);
  return value;
}

function hex(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_64.test(value)) fail(`${field} must be a sha256 hexadecimal fingerprint.`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${field} is unsupported.`);
  return value as T;
}

function assertScope(scope: ContentOperationsScope): void {
  boundedId(scope.workspaceId, "workspaceId");
  boundedId(scope.eventId, "eventId");
  boundedId(scope.actorId, "actorId");
  if (scope.actorKind === "speaker") {
    if (!scope.personId) fail("Speaker content scope must identify the canonical Person.");
    boundedId(scope.personId, "personId");
  } else if (scope.actorKind !== "organizer") {
    fail("Content scope actor kind is unsupported.");
  }
}

function assertPersonScope(scope: ContentOperationsScope, personId: string): void {
  assertScope(scope);
  boundedId(personId, "personId");
  if (scope.actorKind === "speaker" && scope.personId !== personId) {
    throw new ContentOperationsAuthorizationError("A speaker may only access their canonical Person projection.");
  }
}

function assertIdempotencyKey(key: string | undefined): string | null {
  if (key === undefined) return null;
  return text(key, 240, "idempotencyKey");
}

function validateAsset(value: unknown, kind: "HEADSHOT" | "SLIDES"): ContentAssetMetadata {
  const record = plainRecord(value);
  exactKeys(record, ["assetId", "fileName", "mediaType", "byteSize", "checksum", "storageRef"]);
  const assetId = boundedId(record.assetId, "assetId");
  const fileName = typeof record.fileName === "string" && SAFE_FILENAME.test(record.fileName) ? record.fileName : fail("asset fileName is invalid.");
  const mediaType = text(record.mediaType, 160, "asset mediaType");
  const byteSize = record.byteSize;
  const maximum = kind === "HEADSHOT" ? CONTENT_VALIDATION_CONTRACT.headshotBytes : CONTENT_VALIDATION_CONTRACT.slideBytes;
  const allowedTypes = kind === "HEADSHOT" ? CONTENT_VALIDATION_CONTRACT.headshotMediaTypes : CONTENT_VALIDATION_CONTRACT.slideMediaTypes;
  if (typeof byteSize !== "number" || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > maximum) {
    fail(`asset byteSize exceeds the ${kind.toLowerCase()} validation contract.`);
  }
  if (!allowedTypes.includes(mediaType)) fail("asset mediaType is not allowed for this content kind.");
  const checksum = hex(record.checksum, "asset checksum");
  if (typeof record.storageRef !== "string" || !/^synthetic:\/\/[^\s]{1,180}$/u.test(record.storageRef)) {
    fail("asset storageRef must be a local synthetic reference.");
  }
  return Object.freeze({ assetId, fileName, mediaType, byteSize, checksum, storageRef: record.storageRef as `synthetic://${string}` });
}

function validateSocialLinks(value: unknown): readonly SocialLink[] {
  if (!Array.isArray(value) || value.length > 8) fail("socialLinks must contain at most eight entries.");
  const links = value.map((raw) => {
    const record = plainRecord(raw);
    exactKeys(record, ["label", "url"]);
    const label = text(record.label, 80, "social link label");
    const url = text(record.url, 2048, "social link URL");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail("social link URL is invalid.");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      fail("social link URL must be an HTTPS URL without credentials or fragments.");
    }
    return Object.freeze({ label, url });
  });
  const urls = new Set(links.map((link) => link.url));
  if (urls.size !== links.length) fail("social link URLs must be unique.");
  return Object.freeze(links);
}

export function validateContentPayload(value: unknown): ContentPayload {
  const record = plainRecord(value);
  const kind = oneOf(record.kind, CONTENT_KINDS, "content kind");
  switch (kind) {
    case "PROFILE": {
      exactKeys(record, ["kind", "bio", "publicTitle", "organization", "socialLinks", "headshot"]);
      const headshot = record.headshot === null ? null : validateAsset(record.headshot, "HEADSHOT");
      return Object.freeze({
        kind,
        bio: text(record.bio, CONTENT_VALIDATION_CONTRACT.bioBytes, "bio"),
        publicTitle: text(record.publicTitle, CONTENT_VALIDATION_CONTRACT.sessionTitleBytes, "publicTitle"),
        organization: text(record.organization, 240, "organization"),
        socialLinks: validateSocialLinks(record.socialLinks),
        headshot,
      });
    }
    case "BIO":
      exactKeys(record, ["kind", "bio"]);
      return Object.freeze({ kind, bio: text(record.bio, CONTENT_VALIDATION_CONTRACT.bioBytes, "bio") });
    case "SESSION_TITLE":
      exactKeys(record, ["kind", "title"]);
      return Object.freeze({ kind, title: text(record.title, CONTENT_VALIDATION_CONTRACT.sessionTitleBytes, "title") });
    case "SESSION_DESCRIPTION":
      exactKeys(record, ["kind", "description"]);
      return Object.freeze({ kind, description: text(record.description, CONTENT_VALIDATION_CONTRACT.sessionDescriptionBytes, "description") });
    case "SOCIAL_LINKS":
      exactKeys(record, ["kind", "links"]);
      return Object.freeze({ kind, links: validateSocialLinks(record.links) });
    case "HEADSHOT":
      exactKeys(record, ["kind", "asset"]);
      return Object.freeze({ kind, asset: validateAsset(record.asset, kind) });
    case "SLIDES":
      exactKeys(record, ["kind", "asset"]);
      return Object.freeze({ kind, asset: validateAsset(record.asset, kind) });
    case "LOGISTICS":
      exactKeys(record, ["kind", "arrivalWindow", "travelMode", "dietaryNotes"]);
      return Object.freeze({
        kind,
        arrivalWindow: text(record.arrivalWindow, 240, "arrivalWindow"),
        travelMode: oneOf(record.travelMode, ["LOCAL", "TRAIN", "AIR", "REMOTE", "UNKNOWN"], "travelMode"),
        dietaryNotes: optionalText(record.dietaryNotes, 1000, "dietaryNotes"),
      });
    case "ACKNOWLEDGEMENT":
      exactKeys(record, ["kind", "statementId", "acknowledged"]);
      if (record.acknowledged !== true) fail("acknowledgement must be explicitly true.");
      return Object.freeze({ kind, statementId: boundedId(record.statementId, "statementId"), acknowledged: true as const });
  }
}

function validateReviewText(value: unknown, maxBytes: number, field: string): string {
  return text(value, maxBytes, field);
}

function keyFor(workspaceId: string, eventId: string, personId: string, taskId: string, kind: ContentKind): string {
  return JSON.stringify([workspaceId, eventId, personId, taskId, kind]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function versionStatus(
  version: ContentSubmissionVersion,
  versions: readonly ContentSubmissionVersion[],
  findings: readonly ContentFinding[],
  revisionRequests: readonly ContentRevisionRequest[],
  approvals: readonly ContentApproval[],
): ContentReviewState {
  const latest = versions.at(-1);
  if (latest?.id !== version.id) return "SUPERSEDED";
  if (approvals.some((approval) => approval.submissionVersionId === version.id && approval.submissionContentHash === version.contentHash)) return "APPROVED";
  if (findings.some((finding) => finding.submissionVersionId === version.id && finding.submissionContentHash === version.contentHash && finding.blocksReadiness)) return "BLOCKED";
  if (revisionRequests.some((request) => request.submissionVersionId === version.id && request.submissionContentHash === version.contentHash)) return "CHANGES_REQUESTED";
  return "IN_REVIEW";
}

function findExactVersion(
  versions: readonly ContentSubmissionVersion[],
  personId: string,
  taskId: string,
  versionId: string,
  contentHash: string,
): ContentSubmissionVersion {
  const version = versions.find((candidate) => candidate.id === versionId);
  if (!version || version.personId !== personId || version.taskId !== taskId || version.contentHash !== contentHash) {
    throw new ContentOperationsAuthorizationError("The requested submission version is not in the authorized event projection.");
  }
  return version;
}

export class InMemoryContentOperationsRepository implements ContentOperationsRepository {
  readonly schema = CONTENT_OPERATIONS_SCHEMA;
  private readonly versions = new Map<string, ContentSubmissionVersion[]>();
  private readonly comments = new Map<string, ContentComment[]>();
  private readonly findings = new Map<string, ContentFinding[]>();
  private readonly revisionRequests = new Map<string, ContentRevisionRequest[]>();
  private readonly approvals = new Map<string, ContentApproval[]>();
  private readonly idempotency = new Map<string, { readonly fingerprint: string; readonly result: unknown }>();
  private readonly clock: Clock;

  constructor(options: { readonly clock?: Clock } = {}) {
    this.clock = options.clock ?? nowIso;
  }

  getReviewProjection(
    scope: ContentOperationsScope,
    target: { readonly personId: string; readonly taskId: string; readonly kind: ContentKind },
  ): ContentReviewProjection {
    assertPersonScope(scope, target.personId);
    boundedId(target.taskId, "taskId");
    oneOf(target.kind, CONTENT_KINDS, "content kind");
    const key = keyFor(scope.workspaceId, scope.eventId, target.personId, target.taskId, target.kind);
    const versions = this.versions.get(key) ?? [];
    const comments = this.comments.get(key) ?? [];
    const findings = this.findings.get(key) ?? [];
    const revisionRequests = this.revisionRequests.get(key) ?? [];
    const approvals = this.approvals.get(key) ?? [];
    const views = versions.map((version) => ({ ...version, reviewState: versionStatus(version, versions, findings, revisionRequests, approvals) }));
    const latest = views.at(-1);
    return deepFreeze(clone({
      schema: CONTENT_OPERATIONS_SCHEMA,
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: target.personId,
      taskId: target.taskId,
      kind: target.kind,
      versions: views,
      latestVersionId: latest?.id ?? null,
      latestReviewState: latest?.reviewState ?? "NOT_SUBMITTED",
      comments,
      findings,
      revisionRequests,
      approvals,
    }));
  }

  submitVersion(scope: ContentOperationsScope, input: SubmitContentVersionInput): ContentSubmissionVersion {
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    const payload = validateContentPayload(input.payload);
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = fingerprintOf({
      schema: CONTENT_OPERATIONS_SCHEMA,
      operation: "submit-version",
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: input.personId,
      taskId: input.taskId,
      payload,
    });
    const idempotency = idempotencyKey ? `${scope.workspaceId}:${scope.eventId}:${scope.actorId}:${idempotencyKey}` : null;
    if (idempotency) {
      const prior = this.idempotency.get(idempotency);
      if (prior) {
        if (prior.fingerprint !== fingerprint) conflict("The idempotency key was reused with different content.");
        return clone(prior.result as ContentSubmissionVersion);
      }
    }
    const kind = payload.kind;
    const key = keyFor(scope.workspaceId, scope.eventId, input.personId, input.taskId, kind);
    const history = this.versions.get(key) ?? [];
    const prior = history.at(-1) ?? null;
    const versionNumber = history.length + 1;
    const version: ContentSubmissionVersion = deepFreeze({
      id: deterministicUuid(`content-version:${scope.workspaceId}:${scope.eventId}:${input.personId}:${input.taskId}:${kind}:${versionNumber}`),
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: input.personId,
      taskId: input.taskId,
      kind,
      version: versionNumber,
      supersedesVersionId: prior?.id ?? null,
      payload,
      contentHash: fingerprintOf(payload),
      payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
      submittedAt: this.clock(),
      submittedBy: scope.actorId,
      submittedByKind: scope.actorKind,
      source: "synthetic-local-projection",
    });
    this.versions.set(key, [...history, version]);
    if (idempotency) this.idempotency.set(idempotency, { fingerprint, result: version });
    return clone(version);
  }

  /**
   * Removes only the newest in-memory version when its enclosing artifact transaction failed.
   * A version that has reached a successful caller boundary is never passed here.
   */
  rollbackUnpublishedVersion(version: ContentSubmissionVersion): void {
    const key = keyFor(version.workspaceId, version.eventId, version.personId, version.taskId, version.kind);
    const history = this.versions.get(key);
    if (!history) return;
    const latest = history.at(-1);
    if (
      !latest ||
      latest.id !== version.id ||
      latest.contentHash !== version.contentHash ||
      latest.workspaceId !== version.workspaceId ||
      latest.eventId !== version.eventId ||
      latest.personId !== version.personId ||
      latest.taskId !== version.taskId ||
      latest.kind !== version.kind
    ) {
      throw new ContentOperationsConflictError("Only the newest unpublished content version can be rolled back.");
    }
    if (history.length === 1) this.versions.delete(key);
    else this.versions.set(key, history.slice(0, -1));
    for (const [idempotencyKey, entry] of this.idempotency.entries()) {
      const result = entry.result;
      if (
        result !== null &&
        typeof result === "object" &&
        (result as { readonly id?: unknown }).id === version.id &&
        (result as { readonly contentHash?: unknown }).contentHash === version.contentHash
      ) {
        this.idempotency.delete(idempotencyKey);
      }
    }
  }

  addComment(scope: ContentOperationsScope, input: AddContentCommentInput): ContentComment {
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    hex(input.submissionContentHash, "submissionContentHash");
    const key = this.findKeyForExactVersion(scope, input.personId, input.taskId, input.submissionVersionId, input.submissionContentHash);
    const body = validateReviewText(input.body, CONTENT_VALIDATION_CONTRACT.commentBytes, "comment body");
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = fingerprintOf({ operation: "comment", scope, input: { ...input, body } });
    const idempotency = idempotencyKey ? `${scope.workspaceId}:${scope.eventId}:${scope.actorId}:${idempotencyKey}` : null;
    if (idempotency) {
      const prior = this.idempotency.get(idempotency);
      if (prior) {
        if (prior.fingerprint !== fingerprint) conflict("The idempotency key was reused with different comment content.");
        return clone(prior.result as ContentComment);
      }
    }
    const comment: ContentComment = deepFreeze({
      id: deterministicUuid(`content-comment:${scope.workspaceId}:${scope.eventId}:${input.submissionVersionId}:${this.listForKey(this.comments, key).length + 1}`),
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: input.personId,
      taskId: input.taskId,
      submissionVersionId: input.submissionVersionId,
      submissionContentHash: input.submissionContentHash,
      body,
      authorId: scope.actorId,
      authorKind: scope.actorKind,
      createdAt: this.clock(),
    });
    this.comments.set(key, [...this.listForKey(this.comments, key), comment]);
    if (idempotency) this.idempotency.set(idempotency, { fingerprint, result: comment });
    return clone(comment);
  }

  addFinding(scope: ContentOperationsScope, input: AddContentFindingInput): ContentFinding {
    if (scope.actorKind !== "organizer") throw new ContentOperationsAuthorizationError("Only an organizer may create content findings.");
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    hex(input.submissionContentHash, "submissionContentHash");
    const key = this.findKeyForExactVersion(scope, input.personId, input.taskId, input.submissionVersionId, input.submissionContentHash);
    const severity = oneOf(input.severity, CONTENT_SEVERITIES, "finding severity");
    const message = validateReviewText(input.message, CONTENT_VALIDATION_CONTRACT.commentBytes, "finding message");
    const blocksReadiness = input.blocksReadiness ?? severity === "BLOCKER";
    if (typeof blocksReadiness !== "boolean") fail("blocksReadiness must be boolean.");
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = fingerprintOf({ operation: "finding", scope, input: { ...input, severity, message, blocksReadiness } });
    const idempotency = idempotencyKey ? `${scope.workspaceId}:${scope.eventId}:${scope.actorId}:${idempotencyKey}` : null;
    if (idempotency) {
      const prior = this.idempotency.get(idempotency);
      if (prior) {
        if (prior.fingerprint !== fingerprint) conflict("The idempotency key was reused with different finding content.");
        return clone(prior.result as ContentFinding);
      }
    }
    const finding: ContentFinding = deepFreeze({
      id: deterministicUuid(`content-finding:${scope.workspaceId}:${scope.eventId}:${input.submissionVersionId}:${this.listForKey(this.findings, key).length + 1}`),
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: input.personId,
      taskId: input.taskId,
      submissionVersionId: input.submissionVersionId,
      submissionContentHash: input.submissionContentHash,
      severity,
      message,
      blocksReadiness,
      createdAt: this.clock(),
      createdBy: scope.actorId,
    });
    this.findings.set(key, [...this.listForKey(this.findings, key), finding]);
    if (idempotency) this.idempotency.set(idempotency, { fingerprint, result: finding });
    return clone(finding);
  }

  requestRevision(scope: ContentOperationsScope, input: RequestContentRevisionInput): ContentRevisionRequest {
    if (scope.actorKind !== "organizer") throw new ContentOperationsAuthorizationError("Only an organizer may request content revisions.");
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    hex(input.submissionContentHash, "submissionContentHash");
    const key = this.findKeyForExactVersion(scope, input.personId, input.taskId, input.submissionVersionId, input.submissionContentHash);
    const reason = validateReviewText(input.reason, CONTENT_VALIDATION_CONTRACT.revisionReasonBytes, "revision reason");
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = fingerprintOf({ operation: "revision-request", scope, input: { ...input, reason } });
    const idempotency = idempotencyKey ? `${scope.workspaceId}:${scope.eventId}:${scope.actorId}:${idempotencyKey}` : null;
    if (idempotency) {
      const prior = this.idempotency.get(idempotency);
      if (prior) {
        if (prior.fingerprint !== fingerprint) conflict("The idempotency key was reused with different revision content.");
        return clone(prior.result as ContentRevisionRequest);
      }
    }
    const request: ContentRevisionRequest = deepFreeze({
      id: deterministicUuid(`content-revision-request:${scope.workspaceId}:${scope.eventId}:${input.submissionVersionId}:${this.listForKey(this.revisionRequests, key).length + 1}`),
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: input.personId,
      taskId: input.taskId,
      submissionVersionId: input.submissionVersionId,
      submissionContentHash: input.submissionContentHash,
      reason,
      requestedBy: scope.actorId,
      createdAt: this.clock(),
    });
    this.revisionRequests.set(key, [...this.listForKey(this.revisionRequests, key), request]);
    if (idempotency) this.idempotency.set(idempotency, { fingerprint, result: request });
    return clone(request);
  }

  approveVersion(scope: ContentOperationsScope, input: ApproveContentVersionInput): ContentApproval {
    if (scope.actorKind !== "organizer") throw new ContentOperationsAuthorizationError("Only an organizer may approve content.");
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    hex(input.submissionContentHash, "submissionContentHash");
    const key = this.findKeyForExactVersion(scope, input.personId, input.taskId, input.submissionVersionId, input.submissionContentHash);
    const versions = this.versions.get(key) ?? [];
    const version = versions.at(-1);
    if (!version || version.id !== input.submissionVersionId || version.contentHash !== input.submissionContentHash) {
      throw new ContentOperationsConflictError("Only the latest exact submission version may be approved.");
    }
    const findings = this.findings.get(key) ?? [];
    if (findings.some((finding) => finding.submissionVersionId === version.id && finding.submissionContentHash === version.contentHash && finding.blocksReadiness)) {
      throw new ContentOperationsConflictError("A blocking finding must be resolved by a later exact submission before approval.");
    }
    const gate = input.gate ?? "PUBLICATION";
    oneOf(gate, ["CONFIRMATION", "PUBLICATION", "OPERATOR_RELEASE"], "approval gate");
    const approvals = this.approvals.get(key) ?? [];
    const existing = approvals.find((approval) => approval.submissionVersionId === version.id && approval.submissionContentHash === version.contentHash && approval.gate === gate);
    if (existing) return clone(existing);
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = fingerprintOf({ operation: "approve", scope, input: { ...input, gate } });
    const idempotency = idempotencyKey ? `${scope.workspaceId}:${scope.eventId}:${scope.actorId}:${idempotencyKey}` : null;
    if (idempotency) {
      const prior = this.idempotency.get(idempotency);
      if (prior) {
        if (prior.fingerprint !== fingerprint) conflict("The idempotency key was reused with different approval content.");
        return clone(prior.result as ContentApproval);
      }
    }
    const approval: ContentApproval = deepFreeze({
      id: deterministicUuid(`content-approval:${scope.workspaceId}:${scope.eventId}:${version.id}:${gate}`),
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: input.personId,
      taskId: input.taskId,
      submissionVersionId: version.id,
      submissionContentHash: version.contentHash,
      approvedBy: scope.actorId,
      approvedAt: this.clock(),
      gate,
    });
    this.approvals.set(key, [...approvals, approval]);
    if (idempotency) this.idempotency.set(idempotency, { fingerprint, result: approval });
    return clone(approval);
  }

  restoreVersion(scope: ContentOperationsScope, input: RestoreContentVersionInput): ContentSubmissionVersion {
    if (scope.actorKind !== "organizer") throw new ContentOperationsAuthorizationError("Only an organizer may restore content versions.");
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    hex(input.submissionContentHash, "submissionContentHash");
    const key = this.findKeyForExactVersion(scope, input.personId, input.taskId, input.submissionVersionId, input.submissionContentHash);
    const version = (this.versions.get(key) ?? []).find((candidate) => candidate.id === input.submissionVersionId);
    if (!version) throw new ContentOperationsAuthorizationError("The requested submission version is not in the authorized event projection.");
    return this.submitVersion(scope, {
      personId: input.personId,
      taskId: input.taskId,
      payload: version.payload,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:restore:${input.submissionVersionId}` : undefined,
    });
  }

  /** Seed-only helper for deterministic local projections; it still uses normal validation. */
  seedVersion(scope: ContentOperationsScope, input: SubmitContentVersionInput): ContentSubmissionVersion {
    return this.submitVersion(scope, { ...input, idempotencyKey: input.idempotencyKey ?? `seed:${input.personId}:${input.taskId}` });
  }

  private listForKey<T>(map: Map<string, T[]>, key: string): T[] {
    return map.get(key) ?? [];
  }

  private findKeyForExactVersion(scope: ContentOperationsScope, personId: string, taskId: string, versionId: string, contentHash: string): string {
    boundedId(versionId, "submissionVersionId");
    const scopePrefix = `${JSON.stringify([scope.workspaceId, scope.eventId, personId, taskId]).slice(0, -1)},`;
    const matches = [...this.versions.entries()].filter(([key, versions]) => key.startsWith(scopePrefix) && versions.some((version) => version.id === versionId));
    if (matches.length !== 1) throw new ContentOperationsAuthorizationError("The requested submission version is not in the authorized event projection.");
    const [key, versions] = matches[0];
    findExactVersion(versions, personId, taskId, versionId, contentHash);
    return key;
  }
}

const DURABLE_CONTENT_OPERATION_SCHEMA = "sympose-content-operation/v1" as const;
const DURABLE_CONTENT_REVIEW_OPERATION_SCHEMA = "sympose-content-operation/v2" as const;
const DURABLE_CONTENT_EVENT_TYPES = [
  "speaker.content.version.submitted",
  "speaker.content.comment.added",
  "speaker.content.finding.added",
  "speaker.content.revision.requested",
  "speaker.content.approved",
] as const;

type DurableContentEventType = (typeof DURABLE_CONTENT_EVENT_TYPES)[number];

const DURABLE_CONTENT_OPERATIONS = Object.freeze({
  "speaker.content.version.submitted": "submit-version",
  "speaker.content.comment.added": "comment",
  "speaker.content.finding.added": "finding",
  "speaker.content.revision.requested": "revision-request",
  "speaker.content.approved": "approve",
} satisfies Record<DurableContentEventType, string>);

interface DurableContentEventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload_json: string;
  readonly payload_fingerprint: string;
  readonly created_at: string;
}

interface DurableArtifactReviewState {
  readonly states: Map<string, ContentReviewState>;
  readonly approvals: ContentApproval[];
}

interface DurableSpeakerTaskEventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload_json: string;
  readonly payload_fingerprint: string;
}

interface DurableContentTaskDefinition {
  readonly id: string;
  readonly personId: string;
  readonly assignmentId: string;
  readonly kind: string;
  readonly contentKind: ContentKind;
  readonly title: string;
  readonly description: string;
  readonly required: boolean;
  readonly gate: string | null;
  readonly dueAt: string;
  readonly owner: "SPEAKER" | "ORGANIZER";
}

function immutableDurableContentTaskDefinition(
  definition: DurableContentTaskDefinition,
): Omit<DurableContentTaskDefinition, "dueAt"> {
  const { dueAt: _dueAt, ...immutable } = definition;
  return immutable;
}

function isStoredRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactStoredKeys(value: Record<string, unknown>, keys: readonly string[], message: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ContentOperationsConflictError(message);
  }
}

function durableContentTaskAssignmentId(
  db: Db,
  scope: { readonly workspaceId: string; readonly eventId: string },
  personId: string,
  taskId: string,
  kind: ContentKind,
): string {
  const artifactTask = db.prepare(
    `SELECT assignment_id AS assignmentId, task_kind AS taskKind,
            content_kind AS contentKind, title, required, gate, owner
     FROM speaker_tasks
     WHERE id = ? AND workspace_id = ? AND event_id = ? AND person_id = ?`,
  ).get(taskId, scope.workspaceId, scope.eventId, personId) as Record<string, unknown> | undefined;
  const taskEvents = db.prepare(
    `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
            payload_json, payload_fingerprint
     FROM domain_events
     WHERE workspace_id = ? AND aggregate_type = 'speaker_task' AND aggregate_id = ?
       AND event_type IN ('speaker.task.created', 'speaker.task.updated')
     ORDER BY created_at, rowid`,
  ).all(scope.workspaceId, taskId) as unknown as DurableSpeakerTaskEventRow[];
  if (artifactTask && taskEvents.length > 0) {
    throw new ContentOperationsConflictError("Durable content task identity is ambiguous.");
  }
  if (artifactTask) {
    const expectedTitle = kind === "HEADSHOT" ? "Headshot PNG" : "Slides or supporting PDF";
    const expectedRequired = kind === "HEADSHOT" ? 1 : 0;
    const expectedGate = kind === "HEADSHOT" ? "PUBLICATION" : "OPERATOR_RELEASE";
    if (
      typeof artifactTask.assignmentId !== "string" ||
      artifactTask.taskKind !== kind || artifactTask.contentKind !== kind ||
      artifactTask.title !== expectedTitle || artifactTask.required !== expectedRequired ||
      artifactTask.gate !== expectedGate ||
      artifactTask.owner !== "SPEAKER"
    ) {
      throw new ContentOperationsAuthorizationError("The current durable content task is unavailable.");
    }
    return artifactTask.assignmentId;
  }
  if (taskEvents.length === 0) {
    throw new ContentOperationsAuthorizationError("The current durable content task is unavailable.");
  }
  let definition: DurableContentTaskDefinition | null = null;
  for (const row of taskEvents) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      throw new ContentOperationsConflictError("Durable content task evidence is not valid JSON.");
    }
    if (!isStoredRecord(payload) || !isStoredRecord(payload.task)) {
      throw new ContentOperationsConflictError("Durable content task evidence is malformed.");
    }
    const task = payload.task;
    const operationMatches =
      (row.event_type === "speaker.task.created" && payload.operation === "create-task") ||
      (row.event_type === "speaker.task.updated" && (payload.operation === "update-task" || payload.operation === "complete-task"));
    const definitionIsValid =
      typeof task.id === "string" && typeof task.personId === "string" &&
      typeof task.assignmentId === "string" && typeof task.kind === "string" &&
      typeof task.title === "string" && typeof task.description === "string" &&
      typeof task.required === "boolean" &&
      (task.gate === null || task.gate === "CONFIRMATION" || task.gate === "PUBLICATION" || task.gate === "OPERATOR_RELEASE") &&
      typeof task.dueAt === "string" && Number.isFinite(Date.parse(task.dueAt)) &&
      (task.owner === "SPEAKER" || task.owner === "ORGANIZER");
    if (
      canonicalJson(payload) !== row.payload_json || fingerprintOf(payload) !== row.payload_fingerprint ||
      row.workspace_id !== scope.workspaceId || row.aggregate_type !== "speaker_task" || row.aggregate_id !== taskId ||
      row.id !== deterministicUuid(`speaker-operation-event:${row.event_type}:${scope.workspaceId}:${row.payload_fingerprint}`) ||
      payload.schema !== "sympose-speaker-operation/v1" || !operationMatches ||
      payload.workspaceId !== scope.workspaceId || payload.eventId !== scope.eventId ||
      payload.personId !== personId || payload.taskId !== taskId ||
      !definitionIsValid || task.id !== taskId || task.personId !== personId || task.contentKind !== kind
    ) {
      throw new ContentOperationsConflictError("Durable content task identity is inconsistent.");
    }
    const currentDefinition: DurableContentTaskDefinition = {
      id: task.id as string,
      personId: task.personId as string,
      assignmentId: task.assignmentId as string,
      kind: task.kind as string,
      contentKind: task.contentKind as ContentKind,
      title: task.title as string,
      description: task.description as string,
      required: task.required as boolean,
      gate: task.gate as string | null,
      dueAt: task.dueAt as string,
      owner: task.owner as "SPEAKER" | "ORGANIZER",
    };
    if (definition) {
      const immutablePrior = immutableDurableContentTaskDefinition(definition);
      const immutableCurrent = immutableDurableContentTaskDefinition(currentDefinition);
      if (canonicalJson(immutablePrior) !== canonicalJson(immutableCurrent)) {
        throw new ContentOperationsConflictError("Durable content task definition changed.");
      }
    }
    definition = currentDefinition;
  }
  if (!definition) {
    throw new ContentOperationsAuthorizationError("The current durable content task is unavailable.");
  }
  return definition.assignmentId;
}

function currentDurableContentTaskAssignmentId(
  db: Db,
  scope: ContentOperationsScope,
  personId: string,
  taskId: string,
  kind: ContentKind,
): string {
  const assignmentId = durableContentTaskAssignmentId(db, scope, personId, taskId, kind);
  let currentAssignmentId: string;
  try {
    currentAssignmentId = readAcceptedCurrentPlanAssignmentId(db, {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId,
    });
  } catch {
    throw new ContentOperationsAuthorizationError("Speaker content authority is no longer current.");
  }
  if (assignmentId !== currentAssignmentId) {
    throw new ContentOperationsAuthorizationError("Speaker content authority is no longer current.");
  }
  return assignmentId;
}

function parseDurableContentEnvelope(
  row: DurableContentEventRow,
  workspaceId: string,
  eventId: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new ContentOperationsConflictError("Durable content evidence is not valid JSON.");
  }
  if (
    !isStoredRecord(parsed) ||
    canonicalJson(parsed) !== row.payload_json ||
    fingerprintOf(parsed) !== row.payload_fingerprint ||
    row.workspace_id !== workspaceId ||
    (parsed.schema !== DURABLE_CONTENT_OPERATION_SCHEMA && parsed.schema !== DURABLE_CONTENT_REVIEW_OPERATION_SCHEMA) ||
    parsed.workspaceId !== workspaceId ||
    parsed.eventId !== eventId
  ) {
    throw new ContentOperationsConflictError("Durable content evidence is outside the authorized scope.");
  }
  if (!DURABLE_CONTENT_EVENT_TYPES.includes(row.event_type as DurableContentEventType)) {
    throw new ContentOperationsConflictError("Durable content event type is unsupported.");
  }
  const eventType = row.event_type as DurableContentEventType;
  const operation = DURABLE_CONTENT_OPERATIONS[eventType];
  const assignmentBound = parsed.schema === DURABLE_CONTENT_REVIEW_OPERATION_SCHEMA;
  if (
    (operation === "submit-version" && parsed.schema !== DURABLE_CONTENT_OPERATION_SCHEMA) ||
    (operation !== "submit-version" && parsed.schema !== DURABLE_CONTENT_OPERATION_SCHEMA && !assignmentBound)
  ) {
    throw new ContentOperationsConflictError("Durable content operation schema is unsupported.");
  }
  exactStoredKeys(parsed, [
    "schema", "operation", "workspaceId", "eventId", "actorId", "actorKind",
    "personId", "taskId", "kind", "idempotencyKey", "requestFingerprint",
    ...(assignmentBound ? ["assignmentId"] : []),
    operation === "submit-version" ? "version" : "record",
  ], "Durable content operation envelope is malformed.");
  if (
    parsed.operation !== operation ||
    row.id !== durableEventId(eventType, workspaceId, row.payload_fingerprint) ||
    row.aggregate_type !== "speaker_task" ||
    row.aggregate_id !== parsed.taskId ||
    (parsed.actorKind !== "organizer" && parsed.actorKind !== "speaker") ||
    typeof parsed.actorId !== "string" ||
    typeof parsed.personId !== "string" ||
    typeof parsed.taskId !== "string" ||
    !CONTENT_KINDS.includes(parsed.kind as ContentKind) ||
    (assignmentBound && typeof parsed.assignmentId !== "string") ||
    (parsed.idempotencyKey !== null && typeof parsed.idempotencyKey !== "string") ||
    typeof parsed.requestFingerprint !== "string" ||
    !HEX_64.test(parsed.requestFingerprint) ||
    !Number.isFinite(Date.parse(row.created_at))
  ) {
    throw new ContentOperationsConflictError("Durable content operation binding is invalid.");
  }
  if (operation === "submit-version") {
    storedContentVersion(parsed.version, row, parsed);
  } else {
    storedContentReviewRecord(parsed.record, row, parsed);
  }
  return parsed;
}

function storedContentVersion(
  value: unknown,
  row: Pick<DurableContentEventRow, "created_at">,
  envelope: Record<string, unknown>,
): ContentSubmissionVersion {
  if (!isStoredRecord(value)) throw new ContentOperationsConflictError("Durable content version evidence is malformed.");
  exactStoredKeys(value, [
    "id", "workspaceId", "eventId", "personId", "taskId", "kind", "version",
    "supersedesVersionId", "payload", "contentHash", "payloadBytes", "submittedAt",
    "submittedBy", "submittedByKind", "source",
  ], "Durable content version evidence is malformed.");
  const payloadRecord = value.payload;
  let payload: ContentPayload;
  try {
    payload = validateContentPayload(payloadRecord);
  } catch {
    throw new ContentOperationsConflictError("Durable content version payload is invalid.");
  }
  if (
    typeof value.id !== "string" ||
    value.workspaceId !== envelope.workspaceId ||
    value.eventId !== envelope.eventId ||
    value.personId !== envelope.personId ||
    value.taskId !== envelope.taskId ||
    value.kind !== envelope.kind ||
    value.kind !== payload.kind ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    (value.supersedesVersionId !== null && typeof value.supersedesVersionId !== "string") ||
    typeof value.contentHash !== "string" ||
    fingerprintOf(payload) !== value.contentHash ||
    typeof value.payloadBytes !== "number" ||
    !Number.isSafeInteger(value.payloadBytes) ||
    value.payloadBytes !== Buffer.byteLength(JSON.stringify(payload), "utf8") ||
    value.submittedAt !== row.created_at ||
    value.submittedBy !== envelope.actorId ||
    value.submittedByKind !== envelope.actorKind ||
    (value.submittedByKind !== "organizer" && value.submittedByKind !== "speaker") ||
    (value.source !== "synthetic-local-projection" && value.source !== "local-artifact-store") ||
    value.id !== deterministicUuid(`content-version:${String(envelope.workspaceId)}:${String(envelope.eventId)}:${String(envelope.personId)}:${String(envelope.taskId)}:${payload.kind}:${value.version}`)
  ) {
    throw new ContentOperationsConflictError("Durable content version identity is inconsistent.");
  }
  return deepFreeze({
    id: value.id,
    workspaceId: envelope.workspaceId as string,
    eventId: envelope.eventId as string,
    personId: envelope.personId as string,
    taskId: envelope.taskId as string,
    kind: payload.kind,
    version: value.version,
    supersedesVersionId: value.supersedesVersionId,
    payload,
    contentHash: value.contentHash,
    payloadBytes: value.payloadBytes,
    submittedAt: value.submittedAt,
    submittedBy: value.submittedBy as string,
    submittedByKind: value.submittedByKind as "organizer" | "speaker",
    source: value.source as "synthetic-local-projection" | "local-artifact-store",
  });
}

function storedContentReviewRecord(
  value: unknown,
  row: Pick<DurableContentEventRow, "created_at">,
  envelope: Record<string, unknown>,
): ContentComment | ContentFinding | ContentRevisionRequest | ContentApproval {
  if (!isStoredRecord(value)) throw new ContentOperationsConflictError("Durable content review evidence is malformed.");
  const common = ["id", "workspaceId", "eventId", "personId", "taskId", "submissionVersionId", "submissionContentHash"];
  if (
    value.workspaceId !== envelope.workspaceId || value.eventId !== envelope.eventId ||
    value.personId !== envelope.personId || value.taskId !== envelope.taskId ||
    typeof value.id !== "string" || typeof value.submissionVersionId !== "string" ||
    typeof value.submissionContentHash !== "string" || !HEX_64.test(value.submissionContentHash)
  ) throw new ContentOperationsConflictError("Durable content review identity is inconsistent.");

  switch (envelope.operation) {
    case "comment":
      exactStoredKeys(value, [...common, "body", "authorId", "authorKind", "createdAt"], "Durable content comment evidence is malformed.");
      if (typeof value.body !== "string" || value.authorId !== envelope.actorId || value.authorKind !== envelope.actorKind || value.createdAt !== row.created_at) {
        throw new ContentOperationsConflictError("Durable content comment binding is invalid.");
      }
      return value as unknown as ContentComment;
    case "finding":
      exactStoredKeys(value, [...common, "severity", "message", "blocksReadiness", "createdAt", "createdBy"], "Durable content finding evidence is malformed.");
      if (envelope.actorKind !== "organizer" || !CONTENT_SEVERITIES.includes(value.severity as ContentFindingSeverity) || typeof value.message !== "string" || typeof value.blocksReadiness !== "boolean" || value.createdBy !== envelope.actorId || value.createdAt !== row.created_at) {
        throw new ContentOperationsConflictError("Durable content finding binding is invalid.");
      }
      return value as unknown as ContentFinding;
    case "revision-request":
      exactStoredKeys(value, [...common, "reason", "requestedBy", "createdAt"], "Durable content revision evidence is malformed.");
      if (envelope.actorKind !== "organizer" || typeof value.reason !== "string" || value.requestedBy !== envelope.actorId || value.createdAt !== row.created_at) {
        throw new ContentOperationsConflictError("Durable content revision binding is invalid.");
      }
      return value as unknown as ContentRevisionRequest;
    case "approve":
      exactStoredKeys(value, [...common, "approvedBy", "approvedAt", "gate"], "Durable content approval evidence is malformed.");
      if (envelope.actorKind !== "organizer" || value.approvedBy !== envelope.actorId || value.approvedAt !== row.created_at || !["CONFIRMATION", "PUBLICATION", "OPERATOR_RELEASE"].includes(String(value.gate))) {
        throw new ContentOperationsConflictError("Durable content approval binding is invalid.");
      }
      if (value.id !== deterministicUuid(`content-approval:${String(envelope.workspaceId)}:${String(envelope.eventId)}:${String(value.submissionVersionId)}:${String(value.gate)}`)) {
        throw new ContentOperationsConflictError("Durable content approval identity is invalid.");
      }
      return value as unknown as ContentApproval;
    default:
      throw new ContentOperationsConflictError("Durable content review operation is unsupported.");
  }
}

function durableEventId(
  eventType: string,
  workspaceId: string,
  payloadFingerprint: string,
): string {
  return deterministicUuid(`speaker-content-event:${eventType}:${workspaceId}:${payloadFingerprint}`);
}

function ensureDurableContentOutbox(
  db: Db,
  row: DurableContentEventRow,
  eventType: DurableContentEventType,
  payload: Record<string, unknown>,
): void {
  const expectedId = deterministicUuid(`speaker-content-outbox:${row.workspace_id}:${row.id}`);
  const destination = `speaker-content:${eventType}`;
  const payloadJson = canonicalJson({
    schema: "speaker-content-outbox/v1",
    domainEventId: row.id,
    eventType,
    payload,
  });
  const rows = db.prepare(
    `SELECT id, workspace_id, domain_event_id, destination_key, payload_json, created_at
       FROM outbox_messages
      WHERE id = ? OR domain_event_id = ?`,
  ).all(expectedId, row.id) as unknown as Array<Record<string, unknown>>;
  if (rows.length > 1) throw new ContentOperationsConflictError("Durable content outbox companion is ambiguous.");
  const existing = rows[0];
  if (existing) {
    if (
      existing.id !== expectedId || existing.workspace_id !== row.workspace_id ||
      existing.domain_event_id !== row.id || existing.destination_key !== destination ||
      existing.payload_json !== payloadJson || existing.created_at !== row.created_at
    ) throw new ContentOperationsConflictError("Durable content outbox companion is divergent.");
    return;
  }
  db.prepare(
    `INSERT INTO outbox_messages
       (id, workspace_id, domain_event_id, destination_key, payload_json,
        status, attempt_count, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
  ).run(expectedId, row.workspace_id, row.id, destination, payloadJson, row.created_at, row.created_at);
}

function validateOrRepairDurableContentEvent(
  db: Db,
  row: DurableContentEventRow,
  workspaceId: string,
  eventId: string,
  expected?: {
    readonly eventType: DurableContentEventType;
    readonly aggregateId: string;
    readonly payloadJson: string;
    readonly payloadFingerprint: string;
    readonly createdAt: string;
  },
  repairOutbox = true,
): Record<string, unknown> {
  const payload = parseDurableContentEnvelope(row, workspaceId, eventId);
  const eventType = row.event_type as DurableContentEventType;
  if (payload.schema === DURABLE_CONTENT_REVIEW_OPERATION_SCHEMA) {
    const assignmentId = durableContentTaskAssignmentId(
      db,
      { workspaceId, eventId },
      String(payload.personId),
      String(payload.taskId),
      payload.kind as ContentKind,
    );
    if (payload.assignmentId !== assignmentId) {
      throw new ContentOperationsConflictError("Durable content assignment binding is invalid.");
    }
  }
  if (expected && (
    eventType !== expected.eventType || row.aggregate_id !== expected.aggregateId ||
    row.payload_json !== expected.payloadJson || row.payload_fingerprint !== expected.payloadFingerprint ||
    row.created_at !== expected.createdAt
  )) throw new ContentOperationsConflictError("Durable content event replay is divergent.");
  if (repairOutbox) ensureDurableContentOutbox(db, row, eventType, payload);
  return payload;
}

function nextDurableContentCreatedAt(
  db: Db,
  workspaceId: string,
  eventId: string,
  taskId: string,
  proposedAt: string,
): string {
  const proposed = Date.parse(proposedAt);
  if (!Number.isFinite(proposed)) {
    throw new ContentOperationsConflictError("Durable content operation time is invalid.");
  }
  const placeholders = DURABLE_CONTENT_EVENT_TYPES.map(() => "?").join(", ");
  const prior = db.prepare(
    `SELECT created_at AS createdAt
     FROM domain_events
     WHERE workspace_id = ? AND event_type IN (${placeholders})
       AND aggregate_type = 'speaker_task' AND aggregate_id = ?
       AND CASE WHEN json_valid(payload_json)
                THEN json_extract(payload_json, '$.eventId') END = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
  ).get(workspaceId, ...DURABLE_CONTENT_EVENT_TYPES, taskId, eventId) as { createdAt: string } | undefined;
  const priorTime = prior ? Date.parse(prior.createdAt) : Number.NEGATIVE_INFINITY;
  if (prior && !Number.isFinite(priorTime)) {
    throw new ContentOperationsConflictError("Durable content event ordering is invalid.");
  }
  return new Date(Math.max(proposed, priorTime + 1)).toISOString();
}

function appendDurableContentEvent(
  db: Db,
  eventType: DurableContentEventType,
  workspaceId: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  createdAt: string,
): void {
  const payloadJson = canonicalJson(payload);
  const payloadFingerprint = fingerprintOf(payload);
  withTransactionOrSavepoint(db, "speaker_content_operation", () => {
    const existing = db.prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at FROM domain_events
       WHERE workspace_id = ? AND payload_fingerprint = ? LIMIT 1`,
    ).get(workspaceId, payloadFingerprint) as DurableContentEventRow | undefined;
    if (existing) {
      validateOrRepairDurableContentEvent(db, existing, workspaceId, String(payload.eventId), {
        eventType, aggregateId, payloadJson, payloadFingerprint, createdAt,
      });
      return;
    }
    const eventId = durableEventId(eventType, workspaceId, payloadFingerprint);
    db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id,
          payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, ?, 'speaker_task', ?, ?, ?, ?)`,
    ).run(eventId, workspaceId, eventType, aggregateId, payloadJson, payloadFingerprint, createdAt);
    ensureDurableContentOutbox(db, {
      id: eventId, workspace_id: workspaceId, event_type: eventType,
      aggregate_type: "speaker_task", aggregate_id: aggregateId,
      payload_json: payloadJson, payload_fingerprint: payloadFingerprint, created_at: createdAt,
    }, eventType, payload);
  });
}

/**
 * SQLite-backed content operations. Artifact bytes and the V14 artifact rows stay owned by the
 * artifact service. Non-artifact content and editorial facts use the existing immutable
 * domain-event/outbox substrate, so a new repository instance reconstructs the same projection.
 */
export class SqliteContentOperationsRepository implements ContentOperationsRepository {
  readonly schema = CONTENT_OPERATIONS_SCHEMA;
  private readonly stagedArtifactVersions = new Map<string, ContentSubmissionVersion[]>();
  private readonly stagedArtifactIdempotency = new Map<string, { readonly fingerprint: string; readonly result: ContentSubmissionVersion }>();
  private readonly clock: Clock;

  constructor(private readonly db: Db, options: { readonly clock?: Clock } = {}) {
    this.clock = options.clock ?? nowIso;
  }

  getReviewProjection(
    scope: ContentOperationsScope,
    target: { readonly personId: string; readonly taskId: string; readonly kind: ContentKind },
  ): ContentReviewProjection {
    return this.reviewProjection(scope, target, true);
  }

  private reviewProjection(
    scope: ContentOperationsScope,
    target: { readonly personId: string; readonly taskId: string; readonly kind: ContentKind },
    repairOutbox: boolean,
  ): ContentReviewProjection {
    assertPersonScope(scope, target.personId);
    boundedId(target.taskId, "taskId");
    oneOf(target.kind, CONTENT_KINDS, "content kind");
    const durable = target.kind === "HEADSHOT" || target.kind === "SLIDES"
      ? this.readArtifactVersions(scope, { ...target, kind: target.kind as "HEADSHOT" | "SLIDES" })
      : this.readEventVersions(scope, target, repairOutbox);
    const staged = this.stagedArtifactVersions.get(keyFor(scope.workspaceId, scope.eventId, target.personId, target.taskId, target.kind)) ?? [];
    const versions = [...durable.versions, ...staged.filter((candidate) => !durable.versions.some((stored) => stored.id === candidate.id))]
      .sort((left, right) => left.version - right.version || left.id.localeCompare(right.id));
    const comments = this.readRecords<ContentComment>(scope, target, versions, "speaker.content.comment.added", repairOutbox);
    const findings = this.readRecords<ContentFinding>(scope, target, versions, "speaker.content.finding.added", repairOutbox);
    const revisionRequests = this.readRecords<ContentRevisionRequest>(scope, target, versions, "speaker.content.revision.requested", repairOutbox);
    const approvals = [
      ...durable.review.approvals,
      ...this.readRecords<ContentApproval>(scope, target, versions, "speaker.content.approved", repairOutbox),
    ].sort((left, right) => left.approvedAt.localeCompare(right.approvedAt) || left.id.localeCompare(right.id));
    const views = versions.map((version) => ({
      ...version,
      reviewState: durable.review.states.get(version.id) ?? versionStatus(version, versions, findings, revisionRequests, approvals),
    }));
    const latest = views.at(-1);
    return deepFreeze(clone({
      schema: CONTENT_OPERATIONS_SCHEMA,
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: target.personId,
      taskId: target.taskId,
      kind: target.kind,
      versions: views,
      latestVersionId: latest?.id ?? null,
      latestReviewState: latest?.reviewState ?? "NOT_SUBMITTED",
      comments,
      findings,
      revisionRequests,
      approvals,
    }));
  }

  submitVersion(scope: ContentOperationsScope, input: SubmitContentVersionInput): ContentSubmissionVersion {
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    const payload = validateContentPayload(input.payload);
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = fingerprintOf({
      schema: CONTENT_OPERATIONS_SCHEMA,
      operation: "submit-version",
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      personId: input.personId,
      taskId: input.taskId,
      payload,
    });
    const prior = this.priorIdempotentOperation(scope, idempotencyKey, requestFingerprint, "submit-version");
    if (prior) return storedContentVersion(prior.value.version, prior.row, prior.value);

    if (payload.kind === "HEADSHOT" || payload.kind === "SLIDES") {
      const stagedKey = `${scope.workspaceId}:${scope.eventId}:${scope.actorId}:${idempotencyKey ?? ""}`;
      const stagedPrior = idempotencyKey ? this.stagedArtifactIdempotency.get(stagedKey) : undefined;
      if (stagedPrior) {
        if (stagedPrior.fingerprint !== requestFingerprint) conflict("The idempotency key was reused with different content.");
        return clone(stagedPrior.result);
      }
      const target = { personId: input.personId, taskId: input.taskId, kind: payload.kind } as const;
      const history = this.getReviewProjection(scope, target).versions;
      const predecessor = history.at(-1) ?? null;
      const version = deepFreeze({
        id: deterministicUuid(`content-version:${scope.workspaceId}:${scope.eventId}:${input.personId}:${input.taskId}:${payload.kind}:${history.length + 1}`),
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        personId: input.personId,
        taskId: input.taskId,
        kind: payload.kind,
        version: history.length + 1,
        supersedesVersionId: predecessor?.id ?? null,
        payload,
        contentHash: fingerprintOf(payload),
        payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
        submittedAt: this.clock(),
        submittedBy: scope.actorId,
        submittedByKind: scope.actorKind,
        source: "local-artifact-store",
      } satisfies ContentSubmissionVersion);
      const key = keyFor(scope.workspaceId, scope.eventId, input.personId, input.taskId, payload.kind);
      this.stagedArtifactVersions.set(key, [...(this.stagedArtifactVersions.get(key) ?? []), version]);
      if (idempotencyKey) this.stagedArtifactIdempotency.set(stagedKey, { fingerprint: requestFingerprint, result: version });
      return clone(version);
    }

    return withTransactionOrSavepoint(this.db, "speaker_content_version", () => {
      const concurrentPrior = this.priorIdempotentOperation(scope, idempotencyKey, requestFingerprint, "submit-version");
      if (concurrentPrior) return storedContentVersion(concurrentPrior.value.version, concurrentPrior.row, concurrentPrior.value);
      const target = { personId: input.personId, taskId: input.taskId, kind: payload.kind } as const;
      const history = this.getReviewProjection(scope, target).versions;
      const predecessor = history.at(-1) ?? null;
      const version = deepFreeze({
        id: deterministicUuid(`content-version:${scope.workspaceId}:${scope.eventId}:${input.personId}:${input.taskId}:${payload.kind}:${history.length + 1}`),
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        personId: input.personId,
        taskId: input.taskId,
        kind: payload.kind,
        version: history.length + 1,
        supersedesVersionId: predecessor?.id ?? null,
        payload,
        contentHash: fingerprintOf(payload),
        payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
        submittedAt: this.clock(),
        submittedBy: scope.actorId,
        submittedByKind: scope.actorKind,
        source: "synthetic-local-projection",
      } satisfies ContentSubmissionVersion);
      appendDurableContentEvent(this.db, "speaker.content.version.submitted", scope.workspaceId, input.taskId, {
        schema: DURABLE_CONTENT_OPERATION_SCHEMA,
        operation: "submit-version",
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        actorId: scope.actorId,
        actorKind: scope.actorKind,
        personId: input.personId,
        taskId: input.taskId,
        kind: payload.kind,
        idempotencyKey,
        requestFingerprint,
        version,
      }, version.submittedAt);
      return clone(version);
    });
  }

  rollbackUnpublishedVersion(version: ContentSubmissionVersion): void {
    if (version.kind !== "HEADSHOT" && version.kind !== "SLIDES") {
      throw new ContentOperationsConflictError("Durable content versions cannot be removed after recording.");
    }
    const key = keyFor(version.workspaceId, version.eventId, version.personId, version.taskId, version.kind);
    const history = this.stagedArtifactVersions.get(key) ?? [];
    const latest = history.at(-1);
    if (!latest || latest.id !== version.id || latest.contentHash !== version.contentHash) {
      throw new ContentOperationsConflictError("Only the newest unpublished artifact version can be rolled back.");
    }
    if (history.length === 1) this.stagedArtifactVersions.delete(key);
    else this.stagedArtifactVersions.set(key, history.slice(0, -1));
    for (const [idempotencyKey, entry] of this.stagedArtifactIdempotency.entries()) {
      if (entry.result.id === version.id && entry.result.contentHash === version.contentHash) this.stagedArtifactIdempotency.delete(idempotencyKey);
    }
  }

  addComment(scope: ContentOperationsScope, input: AddContentCommentInput): ContentComment {
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    hex(input.submissionContentHash, "submissionContentHash");
    const body = validateReviewText(input.body, CONTENT_VALIDATION_CONTRACT.commentBytes, "comment body");
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = fingerprintOf({ operation: "comment", scope, input: { ...input, body } });
    return withTransactionOrSavepoint(this.db, "speaker_content_comment", () => {
      const exact = this.exactVersion(scope, input.personId, input.taskId, input.submissionVersionId, input.submissionContentHash, false);
      const assignmentId = currentDurableContentTaskAssignmentId(this.db, scope, input.personId, input.taskId, exact.version.kind);
      const prior = this.priorIdempotentOperation(scope, idempotencyKey, requestFingerprint, "comment", false);
      if (prior) {
        const value = validateOrRepairDurableContentEvent(this.db, prior.row, scope.workspaceId, scope.eventId);
        return this.recordFromEnvelope<ContentComment>(value, scope, input.personId, input.taskId);
      }
      const comment = deepFreeze({
        id: deterministicUuid(`content-comment:${scope.workspaceId}:${scope.eventId}:${input.submissionVersionId}:${exact.projection.comments.length + 1}`),
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        personId: input.personId,
        taskId: input.taskId,
        submissionVersionId: input.submissionVersionId,
        submissionContentHash: input.submissionContentHash,
        body,
        authorId: scope.actorId,
        authorKind: scope.actorKind,
        createdAt: nextDurableContentCreatedAt(this.db, scope.workspaceId, scope.eventId, input.taskId, this.clock()),
      } satisfies ContentComment);
      appendDurableContentEvent(this.db, "speaker.content.comment.added", scope.workspaceId, input.taskId, {
        schema: DURABLE_CONTENT_REVIEW_OPERATION_SCHEMA,
        operation: "comment",
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        actorId: scope.actorId,
        actorKind: scope.actorKind,
        personId: input.personId,
        taskId: input.taskId,
        assignmentId,
        kind: exact.version.kind,
        idempotencyKey,
        requestFingerprint,
        record: comment,
      }, comment.createdAt);
      return clone(comment);
    });
  }

  addFinding(scope: ContentOperationsScope, input: AddContentFindingInput): ContentFinding {
    if (scope.actorKind !== "organizer") throw new ContentOperationsAuthorizationError("Only an organizer may create content findings.");
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    hex(input.submissionContentHash, "submissionContentHash");
    const severity = oneOf(input.severity, CONTENT_SEVERITIES, "finding severity");
    const message = validateReviewText(input.message, CONTENT_VALIDATION_CONTRACT.commentBytes, "finding message");
    const blocksReadiness = input.blocksReadiness ?? severity === "BLOCKER";
    if (typeof blocksReadiness !== "boolean") fail("blocksReadiness must be boolean.");
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = fingerprintOf({ operation: "finding", scope, input: { ...input, severity, message, blocksReadiness } });
    return withTransactionOrSavepoint(this.db, "speaker_content_finding", () => {
      const exact = this.exactVersion(scope, input.personId, input.taskId, input.submissionVersionId, input.submissionContentHash, false);
      const assignmentId = currentDurableContentTaskAssignmentId(this.db, scope, input.personId, input.taskId, exact.version.kind);
      const prior = this.priorIdempotentOperation(scope, idempotencyKey, requestFingerprint, "finding", false);
      if (prior) {
        const value = validateOrRepairDurableContentEvent(this.db, prior.row, scope.workspaceId, scope.eventId);
        return this.recordFromEnvelope<ContentFinding>(value, scope, input.personId, input.taskId);
      }
      const finding = deepFreeze({
        id: deterministicUuid(`content-finding:${scope.workspaceId}:${scope.eventId}:${input.submissionVersionId}:${exact.projection.findings.length + 1}`),
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        personId: input.personId,
        taskId: input.taskId,
        submissionVersionId: input.submissionVersionId,
        submissionContentHash: input.submissionContentHash,
        severity,
        message,
        blocksReadiness,
        createdAt: nextDurableContentCreatedAt(this.db, scope.workspaceId, scope.eventId, input.taskId, this.clock()),
        createdBy: scope.actorId,
      } satisfies ContentFinding);
      appendDurableContentEvent(this.db, "speaker.content.finding.added", scope.workspaceId, input.taskId, {
        schema: DURABLE_CONTENT_REVIEW_OPERATION_SCHEMA,
        operation: "finding",
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        actorId: scope.actorId,
        actorKind: scope.actorKind,
        personId: input.personId,
        taskId: input.taskId,
        assignmentId,
        kind: exact.version.kind,
        idempotencyKey,
        requestFingerprint,
        record: finding,
      }, finding.createdAt);
      return clone(finding);
    });
  }

  requestRevision(scope: ContentOperationsScope, input: RequestContentRevisionInput): ContentRevisionRequest {
    if (scope.actorKind !== "organizer") throw new ContentOperationsAuthorizationError("Only an organizer may request content revisions.");
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    hex(input.submissionContentHash, "submissionContentHash");
    const reason = validateReviewText(input.reason, CONTENT_VALIDATION_CONTRACT.revisionReasonBytes, "revision reason");
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = fingerprintOf({ operation: "revision-request", scope, input: { ...input, reason } });
    return withTransactionOrSavepoint(this.db, "speaker_content_revision", () => {
      const exact = this.exactVersion(scope, input.personId, input.taskId, input.submissionVersionId, input.submissionContentHash, false);
      const assignmentId = currentDurableContentTaskAssignmentId(this.db, scope, input.personId, input.taskId, exact.version.kind);
      const prior = this.priorIdempotentOperation(scope, idempotencyKey, requestFingerprint, "revision-request", false);
      if (prior) {
        const value = validateOrRepairDurableContentEvent(this.db, prior.row, scope.workspaceId, scope.eventId);
        return this.recordFromEnvelope<ContentRevisionRequest>(value, scope, input.personId, input.taskId);
      }
      const request = deepFreeze({
        id: deterministicUuid(`content-revision-request:${scope.workspaceId}:${scope.eventId}:${input.submissionVersionId}:${exact.projection.revisionRequests.length + 1}`),
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        personId: input.personId,
        taskId: input.taskId,
        submissionVersionId: input.submissionVersionId,
        submissionContentHash: input.submissionContentHash,
        reason,
        requestedBy: scope.actorId,
        createdAt: nextDurableContentCreatedAt(this.db, scope.workspaceId, scope.eventId, input.taskId, this.clock()),
      } satisfies ContentRevisionRequest);
      appendDurableContentEvent(this.db, "speaker.content.revision.requested", scope.workspaceId, input.taskId, {
        schema: DURABLE_CONTENT_REVIEW_OPERATION_SCHEMA,
        operation: "revision-request",
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        actorId: scope.actorId,
        actorKind: scope.actorKind,
        personId: input.personId,
        taskId: input.taskId,
        assignmentId,
        kind: exact.version.kind,
        idempotencyKey,
        requestFingerprint,
        record: request,
      }, request.createdAt);
      return clone(request);
    });
  }

  approveVersion(scope: ContentOperationsScope, input: ApproveContentVersionInput): ContentApproval {
    if (scope.actorKind !== "organizer") throw new ContentOperationsAuthorizationError("Only an organizer may approve content.");
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    hex(input.submissionContentHash, "submissionContentHash");
    const gate = input.gate ?? "PUBLICATION";
    oneOf(gate, ["CONFIRMATION", "PUBLICATION", "OPERATOR_RELEASE"], "approval gate");
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = fingerprintOf({ operation: "approve", scope, input: { ...input, gate } });
    return withTransactionOrSavepoint(this.db, "speaker_content_approve", () => {
      const exact = this.exactVersion(scope, input.personId, input.taskId, input.submissionVersionId, input.submissionContentHash, false);
      if (exact.version.kind === "HEADSHOT" || exact.version.kind === "SLIDES") {
        throw new ContentOperationsConflictError("Durable artifact approval must use the artifact approval service.");
      }
      const assignmentId = currentDurableContentTaskAssignmentId(this.db, scope, input.personId, input.taskId, exact.version.kind);
      const latest = exact.projection.versions.at(-1);
      if (!latest || latest.id !== exact.version.id) throw new ContentOperationsConflictError("Only the latest exact submission version may be approved.");
      if (exact.projection.findings.some((finding) => finding.submissionVersionId === latest.id && finding.submissionContentHash === latest.contentHash && finding.blocksReadiness)) {
        throw new ContentOperationsConflictError("A blocking finding must be resolved by a later exact submission before approval.");
      }
      const prior = this.priorIdempotentOperation(scope, idempotencyKey, requestFingerprint, "approve", false);
      if (prior) {
        const value = validateOrRepairDurableContentEvent(this.db, prior.row, scope.workspaceId, scope.eventId);
        return this.recordFromEnvelope<ContentApproval>(value, scope, input.personId, input.taskId);
      }
      const existing = exact.projection.approvals.find((approval) => approval.submissionVersionId === latest.id && approval.submissionContentHash === latest.contentHash && approval.gate === gate);
      if (existing) return clone(existing);
      const approval = deepFreeze({
        id: deterministicUuid(`content-approval:${scope.workspaceId}:${scope.eventId}:${latest.id}:${gate}`),
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        personId: input.personId,
        taskId: input.taskId,
        submissionVersionId: latest.id,
        submissionContentHash: latest.contentHash,
        approvedBy: scope.actorId,
        approvedAt: nextDurableContentCreatedAt(this.db, scope.workspaceId, scope.eventId, input.taskId, this.clock()),
        gate,
      } satisfies ContentApproval);
      appendDurableContentEvent(this.db, "speaker.content.approved", scope.workspaceId, input.taskId, {
        schema: DURABLE_CONTENT_REVIEW_OPERATION_SCHEMA,
        operation: "approve",
        workspaceId: scope.workspaceId,
        eventId: scope.eventId,
        actorId: scope.actorId,
        actorKind: scope.actorKind,
        personId: input.personId,
        taskId: input.taskId,
        assignmentId,
        kind: latest.kind,
        idempotencyKey,
        requestFingerprint,
        record: approval,
      }, approval.approvedAt);
      return clone(approval);
    });
  }

  restoreVersion(scope: ContentOperationsScope, input: RestoreContentVersionInput): ContentSubmissionVersion {
    if (scope.actorKind !== "organizer") throw new ContentOperationsAuthorizationError("Only an organizer may restore content versions.");
    assertPersonScope(scope, input.personId);
    boundedId(input.taskId, "taskId");
    hex(input.submissionContentHash, "submissionContentHash");
    const exact = this.exactVersion(scope, input.personId, input.taskId, input.submissionVersionId, input.submissionContentHash);
    if (exact.version.kind === "HEADSHOT" || exact.version.kind === "SLIDES") {
      throw new ContentOperationsConflictError("Durable artifact restoration must use the artifact record flow.");
    }
    return this.submitVersion(scope, {
      personId: input.personId,
      taskId: input.taskId,
      payload: exact.version.payload,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:restore:${input.submissionVersionId}` : undefined,
    });
  }

  private readEventRows(workspaceId: string, eventId: string, eventType: DurableContentEventType): DurableContentEventRow[] {
    return this.db.prepare(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
              payload_json, payload_fingerprint, created_at
       FROM domain_events
       WHERE workspace_id = ? AND event_type = ?
         AND CASE WHEN json_valid(payload_json)
                  THEN json_extract(payload_json, '$.eventId') END = ?
       ORDER BY created_at, rowid`,
    ).all(workspaceId, eventType, eventId) as unknown as DurableContentEventRow[];
  }

  private readEventVersions(
    scope: ContentOperationsScope,
    target: { readonly personId: string; readonly taskId: string; readonly kind: ContentKind },
    repairOutbox = true,
  ): { readonly versions: ContentSubmissionVersion[]; readonly review: DurableArtifactReviewState } {
    const versions: ContentSubmissionVersion[] = [];
    for (const row of this.readEventRows(scope.workspaceId, scope.eventId, "speaker.content.version.submitted")) {
      const value = withTransactionOrSavepoint(this.db, "speaker_content_hydrate", () => validateOrRepairDurableContentEvent(this.db, row, scope.workspaceId, scope.eventId, undefined, repairOutbox));
      if (value.operation !== "submit-version" || value.personId !== target.personId || value.taskId !== target.taskId || value.kind !== target.kind) continue;
      if (row.aggregate_type !== "speaker_task" || row.aggregate_id !== target.taskId) throw new ContentOperationsConflictError("Durable content aggregate binding is invalid.");
      versions.push(storedContentVersion(value.version, row, value));
    }
    versions.sort((left, right) => left.version - right.version || left.id.localeCompare(right.id));
    for (const [index, version] of versions.entries()) {
      const predecessor = versions[index - 1];
      if (version.version !== index + 1 || version.supersedesVersionId !== (predecessor?.id ?? null)) {
        throw new ContentOperationsConflictError("Durable content version lineage is inconsistent.");
      }
    }
    return { versions, review: { states: new Map(), approvals: [] } };
  }

  private readArtifactVersions(
    scope: ContentOperationsScope,
    target: { readonly personId: string; readonly taskId: string; readonly kind: "HEADSHOT" | "SLIDES" },
  ): { readonly versions: ContentSubmissionVersion[]; readonly review: DurableArtifactReviewState } {
    const rows = this.db.prepare(
      `SELECT version.id, version.workspace_id, version.event_id, version.person_id,
              version.task_id, version.kind, version.version, version.supersedes_version_id,
              version.payload_json, version.content_hash, version.payload_bytes,
              version.submitted_at, version.submitted_by, version.submitted_by_kind, version.source,
              review.id AS review_id, review.workspace_id AS review_workspace_id,
              review.event_id AS review_event_id, review.person_id AS review_person_id,
              review.task_id AS review_task_id,
              review.submission_version_id AS review_submission_version_id,
              review.review_state, review.gate, review.reviewed_by, review.reviewed_at,
              review.submission_content_hash
       FROM speaker_content_versions version
       LEFT JOIN speaker_content_reviews review
         ON review.submission_version_id = version.id AND review.workspace_id = version.workspace_id
       WHERE version.workspace_id = ? AND version.event_id = ? AND version.person_id = ?
         AND version.task_id = ? AND version.kind = ?
       ORDER BY version.version, review.reviewed_at, review.id`,
    ).all(scope.workspaceId, scope.eventId, target.personId, target.taskId, target.kind) as unknown as Array<Record<string, unknown>>;
    const versions: ContentSubmissionVersion[] = [];
    const states = new Map<string, ContentReviewState>();
    const approvals: ContentApproval[] = [];
    for (const row of rows) {
      if (!versions.some((candidate) => candidate.id === row.id)) {
        let payload: ContentPayload;
        try {
          payload = validateContentPayload(JSON.parse(String(row.payload_json)));
        } catch {
          throw new ContentOperationsConflictError("Durable artifact content payload is invalid.");
        }
        if (
          row.workspace_id !== scope.workspaceId || row.event_id !== scope.eventId || row.person_id !== target.personId ||
          row.task_id !== target.taskId || row.kind !== payload.kind || row.source !== "local-artifact-store" ||
          typeof row.content_hash !== "string" || fingerprintOf(payload) !== row.content_hash ||
          row.payload_bytes !== Buffer.byteLength(String(row.payload_json), "utf8") ||
          typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1 ||
          row.id !== deterministicUuid(`content-version:${scope.workspaceId}:${scope.eventId}:${target.personId}:${target.taskId}:${target.kind}:${String(row.version)}`) ||
          typeof row.submitted_at !== "string" || !Number.isFinite(Date.parse(row.submitted_at)) ||
          row.submitted_by !== target.personId || row.submitted_by_kind !== "speaker"
        ) throw new ContentOperationsConflictError("Durable artifact content identity is inconsistent.");
        versions.push({
          id: String(row.id), workspaceId: scope.workspaceId, eventId: scope.eventId, personId: target.personId,
          taskId: target.taskId, kind: target.kind, version: row.version, supersedesVersionId: row.supersedes_version_id as string | null,
          payload, contentHash: String(row.content_hash), payloadBytes: row.payload_bytes as number,
          submittedAt: String(row.submitted_at), submittedBy: String(row.submitted_by), submittedByKind: "speaker", source: "local-artifact-store",
        });
      }
      if (typeof row.review_id === "string") {
        const state = row.review_state;
        if (
          row.review_workspace_id !== scope.workspaceId || row.review_event_id !== scope.eventId ||
          row.review_person_id !== target.personId || row.review_task_id !== target.taskId ||
          row.review_submission_version_id !== row.id || row.submission_content_hash !== row.content_hash ||
          typeof row.reviewed_by !== "string" || typeof row.reviewed_at !== "string" || !Number.isFinite(Date.parse(row.reviewed_at)) ||
          !["CONFIRMATION", "PUBLICATION", "OPERATOR_RELEASE"].includes(String(row.gate)) ||
          (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "BLOCKED")
        ) throw new ContentOperationsConflictError("Durable artifact review state is invalid.");
        const prior = states.get(String(row.id));
        if (prior !== "APPROVED") states.set(String(row.id), state);
        if (state === "APPROVED") {
          approvals.push({
            id: String(row.review_id), workspaceId: scope.workspaceId, eventId: scope.eventId, personId: target.personId,
            taskId: target.taskId, submissionVersionId: String(row.id), submissionContentHash: String(row.submission_content_hash),
            approvedBy: String(row.reviewed_by), approvedAt: String(row.reviewed_at), gate: row.gate as ContentApproval["gate"],
          });
        }
      }
    }
    versions.sort((left, right) => left.version - right.version || left.id.localeCompare(right.id));
    for (const [index, version] of versions.entries()) {
      if (version.version !== index + 1 || version.supersedesVersionId !== (versions[index - 1]?.id ?? null)) {
        throw new ContentOperationsConflictError("Durable artifact content lineage is inconsistent.");
      }
    }
    return { versions, review: { states, approvals } };
  }

  private readRecords<T>(
    scope: ContentOperationsScope,
    target: { readonly personId: string; readonly taskId: string; readonly kind: ContentKind },
    versions: readonly ContentSubmissionVersion[],
    eventType: DurableContentEventType,
    repairOutbox = true,
  ): T[] {
    return this.readEventRows(scope.workspaceId, scope.eventId, eventType).flatMap((row) => {
      let value: Record<string, unknown>;
      try {
        value = withTransactionOrSavepoint(this.db, "speaker_content_hydrate", () => validateOrRepairDurableContentEvent(this.db, row, scope.workspaceId, scope.eventId, undefined, repairOutbox));
      } catch (error) {
        // The pre-existing V14 artifact approval service records an exact receipt under the
        // same event type. It is read from speaker_content_reviews above, not as a generic
        // content-operation record.
        if (eventType === "speaker.content.approved") {
          try {
            const raw = JSON.parse(row.payload_json) as unknown;
            if (isStoredRecord(raw) && (raw.schema === "speaker-content-approval-receipt/v1" || raw.schema === "speaker-content-approval-receipt/v2")) return [];
          } catch {
            // Preserve the canonical-evidence error below.
          }
        }
        throw error;
      }
      if (value.personId !== target.personId || value.taskId !== target.taskId || value.kind !== target.kind) return [];
      if (row.aggregate_type !== "speaker_task" || row.aggregate_id !== target.taskId || !isStoredRecord(value.record)) {
        throw new ContentOperationsConflictError("Durable content review binding is invalid.");
      }
      const record = value.record;
      if (record.workspaceId !== scope.workspaceId || record.eventId !== scope.eventId || record.personId !== target.personId || record.taskId !== target.taskId) {
        throw new ContentOperationsConflictError("Durable content review record is outside the authorized scope.");
      }
      findExactVersion(
        versions,
        target.personId,
        target.taskId,
        String(record.submissionVersionId),
        String(record.submissionContentHash),
      );
      return [clone(record as T)];
    });
  }

  private priorIdempotentOperation(
    scope: ContentOperationsScope,
    idempotencyKey: string | null,
    requestFingerprint: string,
    operation: string,
    repairOutbox = true,
  ): { readonly value: Record<string, unknown>; readonly row: DurableContentEventRow } | null {
    if (!idempotencyKey) return null;
    return withTransactionOrSavepoint(this.db, "speaker_content_replay", () => {
      const placeholders = DURABLE_CONTENT_EVENT_TYPES.map(() => "?").join(", ");
      const rows = this.db.prepare(
        `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id,
                payload_json, payload_fingerprint, created_at
         FROM domain_events
         WHERE workspace_id = ? AND event_type IN (${placeholders})
           AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.eventId') END = ?
           AND json_extract(payload_json, '$.actorId') = ?
           AND json_extract(payload_json, '$.idempotencyKey') = ?
         ORDER BY created_at, rowid`,
      ).all(scope.workspaceId, ...DURABLE_CONTENT_EVENT_TYPES, scope.eventId, scope.actorId, idempotencyKey) as unknown as DurableContentEventRow[];
      if (rows.length > 1) throw new ContentOperationsConflictError("Multiple durable content operations use the same idempotency key.");
      if (rows.length === 0) return null;
      const row = rows[0]!;
      const value = validateOrRepairDurableContentEvent(this.db, row, scope.workspaceId, scope.eventId, undefined, repairOutbox);
      if (value.operation !== operation || value.requestFingerprint !== requestFingerprint) throw new ContentOperationsConflictError("The idempotency key was reused with different content.");
      return { value, row };
    });
  }

  private recordFromEnvelope<T>(value: Record<string, unknown>, scope: ContentOperationsScope, personId: string, taskId: string): T {
    if (!isStoredRecord(value.record) || value.record.workspaceId !== scope.workspaceId || value.record.eventId !== scope.eventId || value.record.personId !== personId || value.record.taskId !== taskId) {
      throw new ContentOperationsConflictError("Durable content operation result is outside the authorized scope.");
    }
    return clone(value.record as T);
  }

  private exactVersion(
    scope: ContentOperationsScope,
    personId: string,
    taskId: string,
    versionId: string,
    contentHash: string,
    repairOutbox = true,
  ): { readonly version: ContentSubmissionVersion; readonly projection: ContentReviewProjection } {
    boundedId(versionId, "submissionVersionId");
    let found: { readonly version: ContentSubmissionVersion; readonly projection: ContentReviewProjection } | null = null;
    for (const kind of CONTENT_KINDS) {
      const projection = this.reviewProjection(scope, { personId, taskId, kind }, repairOutbox);
      const version = projection.versions.find((candidate) => candidate.id === versionId);
      if (!version) continue;
      if (version.contentHash !== contentHash || version.personId !== personId || version.taskId !== taskId) {
        throw new ContentOperationsAuthorizationError("The requested submission version is not an exact authorized version.");
      }
      if (found) throw new ContentOperationsConflictError("Multiple content kinds reference one submission version.");
      found = { version, projection };
    }
    if (!found) throw new ContentOperationsAuthorizationError("The requested submission version is not in the authorized event projection.");
    return found;
  }
}

export function rollbackUnpublishedContentVersion(
  repository: ContentOperationsRepository,
  version: ContentSubmissionVersion,
): void {
  if (typeof repository.rollbackUnpublishedVersion !== "function") {
    throw new ContentOperationsConflictError("The content repository cannot compensate an unpublished version.");
  }
  repository.rollbackUnpublishedVersion(version);
}

export function createSyntheticContentOperationsRepository(options: { readonly clock?: Clock } = {}): InMemoryContentOperationsRepository {
  return new InMemoryContentOperationsRepository(options);
}

export function createDurableContentOperationsRepository(db: Db, options: { readonly clock?: Clock } = {}): SqliteContentOperationsRepository {
  return new SqliteContentOperationsRepository(db, options);
}

function publicationRequirementLabel(requirement: ContentPublicationRequirement): string {
  return requirement.label || requirement.id;
}

/**
 * Evaluate the exact content versions that a public release will consume.
 * CONFIRMATION and OPERATOR_RELEASE approvals intentionally do not satisfy the
 * PUBLICATION gate.  A later submission, blocker, or revision request therefore
 * invalidates the current item without mutating any prior approval or release.
 */
export function evaluateContentPublicationGate(
  repository: ContentOperationsRepository,
  scope: ContentOperationsScope,
  requirements: readonly ContentPublicationRequirement[],
): ContentPublicationGate {
  assertScope(scope);
  if (requirements.length === 0) fail("At least one required content publication item is required.");
  const seen = new Set<string>();
  const items = requirements.map((requirement) => {
    boundedId(requirement.id, "publication requirement id");
    if (seen.has(requirement.id)) fail("Publication requirement ids must be unique.");
    seen.add(requirement.id);
    boundedId(requirement.label, "publication requirement label");
    boundedId(requirement.personId, "publication requirement personId");
    boundedId(requirement.taskId, "publication requirement taskId");
    oneOf(requirement.kind, CONTENT_KINDS, "publication requirement content kind");
    if (requirement.required !== true) fail("Only required content publication items may enter this gate.");

    const projection = repository.getReviewProjection(scope, {
      personId: requirement.personId,
      taskId: requirement.taskId,
      kind: requirement.kind,
    });
    const current = projection.versions.find((version) => version.id === projection.latestVersionId) ?? null;
    const currentBlockingFinding = current
      ? projection.findings.some(
          (finding) =>
            finding.submissionVersionId === current.id &&
            finding.submissionContentHash === current.contentHash &&
            finding.blocksReadiness,
        )
      : false;
    const currentRevisionRequested = current
      ? projection.revisionRequests.some(
          (request) =>
            request.submissionVersionId === current.id &&
            request.submissionContentHash === current.contentHash,
        )
      : false;
    const publicationApproval = current
      ? projection.approvals.find(
          (approval) =>
            approval.submissionVersionId === current.id &&
            approval.submissionContentHash === current.contentHash &&
            approval.gate === "PUBLICATION",
        ) ?? null
      : null;
    const rejected =
      currentBlockingFinding ||
      currentRevisionRequested ||
      projection.latestReviewState === "BLOCKED" ||
      projection.latestReviewState === "CHANGES_REQUESTED";
    const status: ContentPublicationItemStatus = !current
      ? "PENDING"
      : rejected
        ? "REJECTED"
        : publicationApproval
          ? "APPROVED"
          : "PENDING";
    const fact: ContentPublicationItemFact = {
      requirement: { ...requirement },
      status,
      currentReviewState: projection.latestReviewState,
      currentVersionId: current?.id ?? null,
      currentContentHash: current?.contentHash ?? null,
      approvedVersionId: publicationApproval?.submissionVersionId ?? null,
      approvedContentHash: publicationApproval?.submissionContentHash ?? null,
      approvedPayload: status === "APPROVED" && current ? current.payload : null,
    };
    return deepFreeze(fact);
  });
  const blockers = items
    .filter((item) => item.status !== "APPROVED")
    .map((item) => {
      const label = publicationRequirementLabel(item.requirement);
      if (item.status === "REJECTED") return `Required public content “${label}” is rejected or needs revision.`;
      if (item.currentReviewState === "NOT_SUBMITTED") return `Required public content “${label}” has not been submitted.`;
      if (item.approvedVersionId === null) return `Required public content “${label}” is not approved for publication.`;
      return `Required public content “${label}” is not ready for publication.`;
    });
  const fingerprint = fingerprintOf({
    schema: "content-publication-gate/v1",
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    source: "content-operations-exact-current-version",
    items,
  });
  return deepFreeze({
    schema: "content-publication-gate/v1",
    workspaceId: scope.workspaceId,
    eventId: scope.eventId,
    state: blockers.length === 0 ? "READY" : "BLOCKED",
    items,
    blockers,
    fingerprint,
    source: "content-operations-exact-current-version",
  });
}
