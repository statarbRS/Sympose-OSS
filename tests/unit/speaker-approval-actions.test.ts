import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import { EVALUATOR_ORGANIZER_ACCOUNT_ID, seedEvaluatorDemo } from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import { canonicalJson, deterministicUuid, fingerprintOf } from "../../src/server/canonical";
import { createSpeakerArtifactRecord } from "../../src/server/services/artifact-records";
import { LocalArtifactStore } from "../../src/server/services/artifact-store";
import { createSyntheticSpeakerOperationsRepository } from "../../src/server/services/speaker-operations";
import {
  EVALUATOR_ARTIFACT_EVENT_ID,
  EVALUATOR_ARTIFACT_PERSON_ID,
  EVALUATOR_ARTIFACT_WORKSPACE_ID,
} from "../../src/server/services/evaluator-speaker-identity";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function classicPdfFixture(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [] /Count 0 >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

const AT = "2026-08-12T12:00:00.000Z";
const WORKSPACE_SLUG = "acme";
const ACCOUNT_ID = EVALUATOR_ORGANIZER_ACCOUNT_ID;
type SpeakerApprovalInput = {
  readonly personId: string;
  readonly taskId: string;
  readonly submissionVersionId: string;
  readonly submissionContentHash: string;
  readonly gate: "CONFIRMATION" | "PUBLICATION" | "OPERATOR_RELEASE";
  readonly idempotencyKey: string;
};

const state = vi.hoisted(() => ({ db: undefined as Db | undefined }));

vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/db")>();
  return { ...actual, getDb: () => state.db };
});
vi.mock("@/server/workspace-session", () => ({
  getRouteSession: vi.fn(async () => ({
    workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
    workspaceSlug: WORKSPACE_SLUG,
    accountId: ACCOUNT_ID,
    role: "organizer",
  })),
  requireOrganizerWorkspaceRoute: vi.fn((_session: unknown, slug: string) => {
    if (slug !== WORKSPACE_SLUG) throw new Error("WORKSPACE_NOT_FOUND");
  }),
}));
vi.mock("@/server/services/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/services/events")>();
  return {
    ...actual,
    getEvent: vi.fn((db: Db, workspaceId: string, eventId: string) => actual.getEvent(db, workspaceId, eventId)),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { approveSpeakerContent } from "../../src/app/w/[workspace]/events/[eventId]/speakers/actions";

const roots: string[] = [];

function form(input: Record<string, string>): FormData {
  const result = new FormData();
  for (const [key, value] of Object.entries(input)) result.set(key, value);
  return result;
}

function artifactInput(taskId: string, gate = "PUBLICATION"): Record<string, string> {
  const version = state.db!.prepare(
    "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE task_id = ? ORDER BY version DESC LIMIT 1",
  ).get(taskId) as { id: string; contentHash: string };
  return {
    workspace: WORKSPACE_SLUG,
    eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    personId: EVALUATOR_ARTIFACT_PERSON_ID,
    taskId,
    submissionVersionId: version.id,
    submissionContentHash: version.contentHash,
    gate,
    idempotencyKey: `approve:${taskId}:${gate}`,
  };
}

function approvalCounts(taskId: string): { reviews: number; receipts: number; bindings: number; releases: number } {
  return {
    reviews: (state.db!.prepare("SELECT COUNT(*) AS count FROM speaker_content_reviews WHERE task_id = ?").get(taskId) as { count: number }).count,
    receipts: (state.db!.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'speaker.content.approved' AND aggregate_id = ?").get(taskId) as { count: number }).count,
    bindings: (state.db!.prepare("SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE artifact_id IN (SELECT id FROM artifact_records WHERE task_id = ?)").get(taskId) as { count: number }).count,
    releases: (state.db!.prepare("SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?").get(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID) as { count: number }).count,
  };
}

type ArtifactKind = "HEADSHOT" | "SLIDES";

function cachedArtifactPayload(kind: ArtifactKind, suffix: string): Record<string, unknown> {
  return {
    kind,
    asset: {
      assetId: `cached-${kind.toLowerCase()}-${suffix}`,
      fileName: kind === "HEADSHOT" ? `cached-${suffix}.png` : `cached-${suffix}.pdf`,
      mediaType: kind === "HEADSHOT" ? "image/png" : "application/pdf",
      byteSize: 1,
      checksum: "a".repeat(64),
      storageRef: `synthetic://cached-artifact/${suffix}`,
    },
  };
}

function cachedArtifactApproval(kind: ArtifactKind, taskId: string, idempotencyKey: string): { input: SpeakerApprovalInput; repository: ReturnType<typeof createSyntheticSpeakerOperationsRepository> } {
  state.db = openDb({ path: ":memory:", seed: false });
  seedWorkspaces(state.db);
  seedEvaluatorDemo(state.db);
  const repository = createSyntheticSpeakerOperationsRepository({ db: state.db, clock: () => AT });
  const task = repository.createTask(organizerScope, {
    personId: EVALUATOR_ARTIFACT_PERSON_ID,
    kind,
    contentKind: kind,
    title: kind === "HEADSHOT" ? "Cached headshot" : "Cached slides",
    description: "Cached artifact regression fixture.",
    required: kind === "HEADSHOT",
    gate: kind === "HEADSHOT" ? "PUBLICATION" : "OPERATOR_RELEASE",
    dueAt: "2026-09-01T00:00:00.000Z",
    owner: "SPEAKER",
  });
  const version = repository.submitOrganizerContent(organizerScope, {
    personId: EVALUATOR_ARTIFACT_PERSON_ID,
    taskId: task.id,
    payload: cachedArtifactPayload(kind, "one"),
    idempotencyKey: `${idempotencyKey}:submission`,
  });
  return {
    input: {
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: task.id,
      submissionVersionId: version.id,
      submissionContentHash: version.contentHash,
      gate: kind === "HEADSHOT" ? "PUBLICATION" : "OPERATOR_RELEASE",
      idempotencyKey,
    },
    repository,
  };
}

function primeOrganizerRepository(repository: ReturnType<typeof createSyntheticSpeakerOperationsRepository>): void {
  repository.getOrganizerProjection(organizerScope, {
    id: EVALUATOR_ARTIFACT_EVENT_ID,
    name: "Synthetic evaluator event",
    timezone: "UTC",
    startsAt: "2026-09-15T09:00:00.000Z",
    endsAt: "2026-09-15T17:00:00.000Z",
  });
}

function addAmbiguousCurrentAssignment(): void {
  const current = state.db!.prepare(
    "SELECT current_plan_version_id AS planId FROM events WHERE workspace_id = ? AND id = ?",
  ).get(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID) as { planId: string };
  state.db!.prepare(
    `INSERT INTO program_units
       (id, workspace_id, event_id, name, unit_type, starts_at, ends_at, capacity, created_at)
     VALUES (?, ?, ?, ?, 'SESSION', ?, ?, 1, ?)`,
  ).run(
    "approval-ambiguous-unit",
    EVALUATOR_ARTIFACT_WORKSPACE_ID,
    EVALUATOR_ARTIFACT_EVENT_ID,
    "Approval ambiguity session",
    "2026-08-12T12:00:00.000Z",
    "2026-08-12T13:00:00.000Z",
    AT,
  );
  state.db!.prepare(
    `INSERT INTO plan_assignments
       (id, workspace_id, plan_version_id, person_id, program_unit_id, assignment_type, explanation)
     VALUES (?, ?, ?, ?, ?, 'SPEAKER', ?)`,
  ).run(
    "approval-ambiguous-assignment",
    EVALUATOR_ARTIFACT_WORKSPACE_ID,
    current.planId,
    EVALUATOR_ARTIFACT_PERSON_ID,
    "approval-ambiguous-unit",
    "Ambiguous current approval authority",
  );
}

function cachedApproval(taskId: string, idempotencyKey: string): { input: SpeakerApprovalInput; repository: ReturnType<typeof createSyntheticSpeakerOperationsRepository>; artifactId: string } {
  state.db = openDb({ path: ":memory:", seed: false });
  seedWorkspaces(state.db);
  seedEvaluatorDemo(state.db);
  const root = mkdtempSync(join(tmpdir(), `sympose-speaker-approval-authority-${taskId}-`));
  roots.push(root);
  const artifact = createSpeakerArtifactRecord(state.db, {
    workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
    eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    personId: EVALUATOR_ARTIFACT_PERSON_ID,
    taskId,
    kind: "HEADSHOT",
  }, { bytes: PNG, mediaType: "image/png", originalFilename: "mina.png" }, { store: new LocalArtifactStore({ rootDir: root, clock: () => AT }) });
  const baseInput = artifactInput(taskId);
  const input: SpeakerApprovalInput = {
    personId: baseInput.personId!,
    taskId: baseInput.taskId!,
    submissionVersionId: baseInput.submissionVersionId!,
    submissionContentHash: baseInput.submissionContentHash!,
    gate: "PUBLICATION",
    idempotencyKey,
  };
  return {
    input,
    repository: createSyntheticSpeakerOperationsRepository({ db: state.db, clock: () => AT }),
    artifactId: artifact.artifactId,
  };
}

const organizerScope = {
  kind: "organizer" as const,
  workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
  eventId: EVALUATOR_ARTIFACT_EVENT_ID,
  actorId: ACCOUNT_ID,
};

afterEach(() => {
  if (state.db) closeDb(state.db);
  state.db = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("organizer speaker approval action", () => {
  it("uses the durable repository and survives DB reopen without mutating a sealed release", async () => {
    const root = mkdtempSync(join(tmpdir(), "sympose-speaker-approval-action-"));
    roots.push(root);
    const path = join(root, "approval.sqlite");
    state.db = openDb({ path, seed: false });
    seedWorkspaces(state.db);
    seedEvaluatorDemo(state.db);
    const store = new LocalArtifactStore({ rootDir: root, clock: () => AT });
    const scope = {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: "action-headshot-task",
      kind: "HEADSHOT" as const,
    };
    const artifact = createSpeakerArtifactRecord(state.db, scope, {
      bytes: PNG,
      mediaType: "image/png",
      originalFilename: "mina.png",
    }, { store });
    const version = state.db.prepare(
      "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE task_id = ?",
    ).get(scope.taskId) as { id: string; contentHash: string };

    await approveSpeakerContent(form({
      workspace: WORKSPACE_SLUG,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: scope.taskId,
      submissionVersionId: version.id,
      submissionContentHash: version.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: "action-approval-1",
    }));
    await approveSpeakerContent(form({
      workspace: WORKSPACE_SLUG,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: scope.taskId,
      submissionVersionId: version.id,
      submissionContentHash: version.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: "action-approval-1",
    }));
    await expect(approveSpeakerContent(form({
      workspace: WORKSPACE_SLUG,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: "different-person",
      taskId: scope.taskId,
      submissionVersionId: version.id,
      submissionContentHash: version.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: "action-approval-1",
    }))).rejects.toThrow(/idempotency/u);

    expect(state.db.prepare("SELECT COUNT(*) AS count FROM speaker_content_reviews WHERE task_id = ? AND gate = 'PUBLICATION'").get(scope.taskId)).toEqual({ count: 1 });
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE artifact_id = ?").get(artifact.artifactId)).toEqual({ count: 0 });

    closeDb(state.db);
    state.db = openDb({ path, seed: false });
    expect(state.db.prepare("SELECT review_state, gate FROM speaker_content_reviews WHERE task_id = ?").get(scope.taskId)).toEqual({ review_state: "APPROVED", gate: "PUBLICATION" });
    expect(state.db.prepare("SELECT artifact_id FROM speaker_artifact_release_bindings WHERE artifact_id = ?").get(artifact.artifactId)).toBeUndefined();
  });

  it("does not bind wrong gate, non-headshot, stale exact inputs, or wrong scope", async () => {
    state.db = openDb({ path: ":memory:", seed: false });
    seedWorkspaces(state.db);
    seedEvaluatorDemo(state.db);
    const root = mkdtempSync(join(tmpdir(), "sympose-speaker-approval-negative-"));
    roots.push(root);
    const store = new LocalArtifactStore({ rootDir: root, clock: () => AT });
    const headshot = createSpeakerArtifactRecord(state.db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: "negative-headshot-task",
      kind: "HEADSHOT",
    }, { bytes: PNG, mediaType: "image/png", originalFilename: "mina.png" }, { store });
    const slides = createSpeakerArtifactRecord(state.db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: "negative-slides-task",
      kind: "SLIDES",
    }, { bytes: classicPdfFixture(), mediaType: "application/pdf", originalFilename: "slides.pdf" }, { store });
    const headshotVersion = artifactInput("negative-headshot-task", "CONFIRMATION");
    await approveSpeakerContent(form(headshotVersion));
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE artifact_id = ?").get(headshot.artifactId)).toEqual({ count: 0 });

    await expect(approveSpeakerContent(form({ ...artifactInput("negative-headshot-task"), submissionContentHash: "0".repeat(64) }))).rejects.toThrow();
    await expect(approveSpeakerContent(form({ ...artifactInput("negative-headshot-task"), personId: "wrong-person" }))).rejects.toThrow();
    await expect(approveSpeakerContent(form({ ...artifactInput("negative-headshot-task"), taskId: "wrong-task" }))).rejects.toThrow();
    await approveSpeakerContent(form(artifactInput("negative-slides-task")));
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE artifact_id = ?").get(slides.artifactId)).toEqual({ count: 0 });
    await expect(approveSpeakerContent(form({ ...artifactInput("negative-headshot-task"), workspace: "wrong-workspace" }))).rejects.toThrow();
    await expect(approveSpeakerContent(form({ ...artifactInput("negative-headshot-task"), eventId: "wrong-event" }))).rejects.toThrow();
  });

  it("rejects a canonical receipt whose key and command fingerprint do not prove aggregate or outcome authority", async () => {
    state.db = openDb({ path: ":memory:", seed: false });
    seedWorkspaces(state.db);
    seedEvaluatorDemo(state.db);
    const root = mkdtempSync(join(tmpdir(), "sympose-speaker-approval-receipt-"));
    roots.push(root);
    const store = new LocalArtifactStore({ rootDir: root, clock: () => AT });
    const taskId = "forged-receipt-task";
    const artifact = createSpeakerArtifactRecord(state.db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId,
      kind: "HEADSHOT",
    }, { bytes: PNG, mediaType: "image/png", originalFilename: "mina.png" }, { store });
    const version = state.db.prepare(
      "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE task_id = ?",
    ).get(taskId) as { id: string; contentHash: string };
    const key = "forged-receipt-key";
    const command = {
      schema: "speaker-content-approval-command/v1",
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      actorId: ACCOUNT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId,
      submissionVersionId: version.id,
      submissionContentHash: version.contentHash,
      kind: "HEADSHOT",
      gate: "PUBLICATION",
      idempotencyKey: key,
    } as const;
    const forgedPayload = {
      schema: "speaker-content-approval-receipt/v1",
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      actorId: ACCOUNT_ID,
      idempotencyKey: key,
      commandFingerprint: fingerprintOf(command),
      kind: "HEADSHOT",
      outcome: {
        id: "forged", workspaceId: "wrong-workspace", eventId: EVALUATOR_ARTIFACT_EVENT_ID,
        personId: EVALUATOR_ARTIFACT_PERSON_ID, taskId, submissionVersionId: version.id,
        submissionContentHash: version.contentHash, approvedBy: ACCOUNT_ID, approvedAt: AT, gate: "PUBLICATION",
      },
    };
    state.db.prepare(
      `INSERT INTO domain_events
       (id, workspace_id, event_type, aggregate_type, aggregate_id, payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, 'speaker.content.approved', 'wrong_aggregate', ?, ?, ?, ?)`,
    ).run(
      deterministicUuid(`forged-receipt:${key}`), EVALUATOR_ARTIFACT_WORKSPACE_ID, taskId,
      canonicalJson(forgedPayload), fingerprintOf(forgedPayload), AT,
    );

    await expect(approveSpeakerContent(form({
      workspace: WORKSPACE_SLUG,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId,
      submissionVersionId: version.id,
      submissionContentHash: version.contentHash,
      gate: "PUBLICATION",
      idempotencyKey: key,
    }))).rejects.toThrow(/idempotency|receipt|approval/u);
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM speaker_content_reviews WHERE task_id = ?").get(taskId)).toEqual({ count: 0 });
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE artifact_id = ?").get(artifact.artifactId)).toEqual({ count: 0 });
  });

  it("replays an approved headshot receipt without requiring or creating a release binding", () => {
    const prepared = cachedApproval("approval-replay-without-binding-task", "approval-replay-without-binding-key");
    const approval = prepared.repository.approveContent(organizerScope, prepared.input);
    expect(approvalCounts(prepared.input.taskId)).toEqual({ reviews: 1, receipts: 1, bindings: 0, releases: 1 });
    expect(prepared.repository.approveContent(organizerScope, prepared.input)).toEqual(approval);
    expect(approvalCounts(prepared.input.taskId)).toEqual({ reviews: 1, receipts: 1, bindings: 0, releases: 1 });
  });

  it("denies the first approval before any durable writes when current assignment authority is ambiguous", () => {
    const prepared = cachedApproval("authority-ambiguous-first-task", "authority-ambiguous-first-key");
    primeOrganizerRepository(prepared.repository);
    addAmbiguousCurrentAssignment();
    expect(() => prepared.repository.approveContent(organizerScope, prepared.input)).toThrow(/authority|stale|unavailable/iu);
    expect(approvalCounts(prepared.input.taskId)).toEqual({ reviews: 0, receipts: 0, bindings: 0, releases: 1 });
  });

  it("denies an approval receipt replay when current assignment authority becomes ambiguous", () => {
    const prepared = cachedApproval("authority-ambiguous-replay-task", "authority-ambiguous-replay-key");
    prepared.repository.approveContent(organizerScope, prepared.input);
    const before = { reviews: 1, receipts: 1, bindings: 0, releases: 1 };
    expect(approvalCounts(prepared.input.taskId)).toEqual(before);
    addAmbiguousCurrentAssignment();
    expect(() => prepared.repository.approveContent(organizerScope, prepared.input)).toThrow(/authority|stale|unavailable/iu);
    expect(approvalCounts(prepared.input.taskId)).toEqual(before);
  });

  it("writes an assignment-bound v2 receipt and replays the historical v1 receipt contract", () => {
    const prepared = cachedApproval("authority-receipt-version-task", "authority-receipt-version-key");
    const approval = prepared.repository.approveContent(organizerScope, prepared.input);
    const task = state.db!.prepare("SELECT assignment_id AS assignmentId FROM speaker_tasks WHERE id = ?").get(prepared.input.taskId) as { assignmentId: string };
    const receipt = state.db!.prepare(
      "SELECT id, payload_json AS payloadJson FROM domain_events WHERE workspace_id = ? AND aggregate_id = ? AND event_type = 'speaker.content.approved'",
    ).get(EVALUATOR_ARTIFACT_WORKSPACE_ID, prepared.input.taskId) as { id: string; payloadJson: string };
    expect(JSON.parse(receipt.payloadJson)).toMatchObject({
      schema: "speaker-content-approval-receipt/v2",
      assignmentId: task.assignmentId,
      outcome: approval,
    });
    expect(prepared.repository.approveContent(organizerScope, prepared.input)).toEqual(approval);

    const legacyCommand = {
      schema: "speaker-content-approval-command/v1",
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      actorId: ACCOUNT_ID,
      personId: prepared.input.personId,
      taskId: prepared.input.taskId,
      submissionVersionId: prepared.input.submissionVersionId,
      submissionContentHash: prepared.input.submissionContentHash,
      kind: "HEADSHOT",
      gate: prepared.input.gate,
      idempotencyKey: prepared.input.idempotencyKey,
    } as const;
    const legacyReceipt = JSON.parse(receipt.payloadJson) as Record<string, unknown>;
    legacyReceipt.schema = "speaker-content-approval-receipt/v1";
    legacyReceipt.commandFingerprint = fingerprintOf(legacyCommand);
    delete legacyReceipt.assignmentId;
    state.db!.exec("DROP TRIGGER trg_v12_domain_events_immutable");
    state.db!.prepare("UPDATE domain_events SET payload_json = ?, payload_fingerprint = ? WHERE id = ?")
      .run(canonicalJson(legacyReceipt), fingerprintOf(legacyReceipt), receipt.id);
    const before = approvalCounts(prepared.input.taskId);
    expect(prepared.repository.approveContent(organizerScope, prepared.input)).toEqual(approval);
    expect(approvalCounts(prepared.input.taskId)).toEqual(before);
  });

  it("denies artifact receipt replay after accepted speaker authority is withdrawn", () => {
    const prepared = cachedApproval("authority-withdrawn-replay-task", "authority-withdrawn-replay-key");
    prepared.repository.approveContent(organizerScope, prepared.input);
    const before = approvalCounts(prepared.input.taskId);
    state.db!.prepare(
      `UPDATE event_speakers SET participation_status = 'DECLINED', updated_at = ?
       WHERE workspace_id = ? AND event_id = ? AND person_id = ?`,
    ).run(AT, EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID, EVALUATOR_ARTIFACT_PERSON_ID);
    expect(() => prepared.repository.approveContent(organizerScope, prepared.input)).toThrow(/authority|current|unavailable/iu);
    expect(approvalCounts(prepared.input.taskId)).toEqual(before);
  });

  it.each(["HEADSHOT", "SLIDES"] as const)("rejects cached-only %s approval without durable task identity", (kind) => {
    const prepared = cachedArtifactApproval(kind, `cached-only-${kind.toLowerCase()}-task`, `cached-only-${kind.toLowerCase()}-approval`);
    expect(() => prepared.repository.approveContent(organizerScope, prepared.input)).toThrow(/durable artifact|identity/iu);
    expect(approvalCounts(prepared.input.taskId)).toEqual({ reviews: 0, receipts: 0, bindings: 0, releases: 1 });
  });

  it("rejects a cached artifact version that diverges from its durable version identity", () => {
    const prepared = cachedApproval("authority-divergent-version-task", "authority-divergent-version-key");
    const cachedScope = { actorKind: "organizer" as const, workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID, eventId: EVALUATOR_ARTIFACT_EVENT_ID, actorId: ACCOUNT_ID };
    prepared.repository.content.submitVersion(cachedScope, {
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: prepared.input.taskId,
      payload: cachedArtifactPayload("HEADSHOT", "one"),
      idempotencyKey: "cached-divergent-version-one",
    });
    const divergentVersion = prepared.repository.content.submitVersion(cachedScope, {
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: prepared.input.taskId,
      payload: cachedArtifactPayload("HEADSHOT", "two"),
      idempotencyKey: "cached-divergent-version-two",
    });
    const divergentInput = { ...prepared.input, submissionVersionId: divergentVersion.id, submissionContentHash: divergentVersion.contentHash, idempotencyKey: "authority-divergent-version-retry" };
    expect(() => prepared.repository.approveContent(organizerScope, divergentInput)).toThrow(/durable artifact|identity|content/iu);
    expect(approvalCounts(prepared.input.taskId)).toEqual({ reviews: 0, receipts: 0, bindings: 0, releases: 1 });
  });

  it("does not touch the release-binding table while approving a headshot", () => {
    const prepared = cachedApproval("authority-atomic-task", "authority-atomic-key");
    state.db!.exec("CREATE TRIGGER authority_probe_abort_binding BEFORE INSERT ON speaker_artifact_release_bindings BEGIN SELECT RAISE(ABORT, 'authority probe binding failure'); END");
    prepared.repository.approveContent(organizerScope, prepared.input);
    expect(approvalCounts(prepared.input.taskId)).toEqual({ reviews: 1, receipts: 1, bindings: 0, releases: 1 });
  });

  it("rejects cached replay when artifact checksum diverges", () => {
    const prepared = cachedApproval("authority-checksum-task", "authority-checksum-key");
    prepared.repository.approveContent(organizerScope, prepared.input);
    const before = approvalCounts(prepared.input.taskId);
    state.db!.exec("DROP TRIGGER trg_artifact_records_immutable");
    state.db!.prepare("UPDATE artifact_records SET sha256 = ? WHERE id = ?").run("0".repeat(64), prepared.artifactId);
    expect(() => prepared.repository.approveContent(organizerScope, prepared.input)).toThrow(/artifact|checksum|content/u);
    expect(approvalCounts(prepared.input.taskId)).toEqual(before);
  });

  it("rejects cached replay when content payload diverges from its stored hash", () => {
    const prepared = cachedApproval("authority-content-task", "authority-content-key");
    prepared.repository.approveContent(organizerScope, prepared.input);
    const before = approvalCounts(prepared.input.taskId);
    const row = state.db!.prepare("SELECT payload_json AS payloadJson FROM speaker_content_versions WHERE id = ?").get(prepared.input.submissionVersionId) as { payloadJson: string };
    const payload = JSON.parse(row.payloadJson) as { asset: { checksum: string } };
    payload.asset.checksum = "1".repeat(64);
    state.db!.exec("DROP TRIGGER trg_speaker_content_versions_immutable");
    state.db!.prepare("UPDATE speaker_content_versions SET payload_json = ? WHERE id = ?").run(canonicalJson(payload), prepared.input.submissionVersionId);
    expect(() => prepared.repository.approveContent(organizerScope, prepared.input)).toThrow(/artifact|checksum|content/u);
    expect(approvalCounts(prepared.input.taskId)).toEqual(before);
  });

  it("rejects cached replay when the event current plan pointer is stale", () => {
    const prepared = cachedApproval("authority-plan-pointer-task", "authority-plan-pointer-key");
    prepared.repository.approveContent(organizerScope, prepared.input);
    const before = approvalCounts(prepared.input.taskId);
    state.db!.prepare("UPDATE events SET current_plan_version_id = NULL WHERE workspace_id = ? AND id = ?").run(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID);
    expect(() => prepared.repository.approveContent(organizerScope, prepared.input)).toThrow(/authority|approval|stale|conflict|scope|unavailable/iu);
    expect(approvalCounts(prepared.input.taskId)).toEqual(before);
  });

  it("rejects cached replay when current plan approval is no longer authoritative", () => {
    const prepared = cachedApproval("authority-plan-approval-task", "authority-plan-approval-key");
    prepared.repository.approveContent(organizerScope, prepared.input);
    const before = approvalCounts(prepared.input.taskId);
    state.db!.exec("DROP TRIGGER trg_approvals_immutable");
    state.db!.prepare("UPDATE approvals SET decision = 'rejected' WHERE workspace_id = ? AND event_id = ? AND plan_version_id = (SELECT current_plan_version_id FROM events WHERE workspace_id = ? AND id = ?)").run(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID, EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID);
    expect(() => prepared.repository.approveContent(organizerScope, prepared.input)).toThrow(/authority|approval|stale|conflict|scope|unavailable/iu);
    expect(approvalCounts(prepared.input.taskId)).toEqual(before);
  });

  it("keeps approval replay independent from mutable current-release state", () => {
    const prepared = cachedApproval("authority-release-task", "authority-release-key");
    prepared.repository.approveContent(organizerScope, prepared.input);
    const before = approvalCounts(prepared.input.taskId);
    const release = state.db!.prepare("SELECT id, content_json AS contentJson FROM publication_releases WHERE id = (SELECT current_release_id FROM events WHERE workspace_id = ? AND id = ?)").get(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID) as { id: string; contentJson: string };
    const content = JSON.parse(release.contentJson) as { event: { name: string } };
    content.event.name = `${content.event.name} tampered`;
    state.db!.exec("DROP TRIGGER trg_releases_immutable");
    state.db!.prepare("UPDATE publication_releases SET content_json = ? WHERE id = ?").run(JSON.stringify(content), release.id);
    expect(prepared.repository.approveContent(organizerScope, prepared.input)).toBeTruthy();
    expect(approvalCounts(prepared.input.taskId)).toEqual(before);
  });
});
