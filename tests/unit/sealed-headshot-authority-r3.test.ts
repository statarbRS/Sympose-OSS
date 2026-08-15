import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, type Db } from "../../src/server/db";
import {
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  seedEvaluatorDemo,
  seedEvaluatorSpeakerTaskFixtures,
} from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import {
  createSpeakerArtifactRecord,
  listPublishedSpeakerHeadshots,
  readPublishedSpeakerHeadshot,
  readPublishedSpeakerHeadshotByAudienceReference,
  readPublishedSpeakerHeadshotByRelease,
  type SpeakerArtifactRecord,
  type SpeakerArtifactScope,
} from "../../src/server/services/artifact-records";
import { LocalArtifactStore } from "../../src/server/services/artifact-store";
import {
  sealRelease,
  type SealedReleaseContent,
} from "../../src/server/services/publication";
import {
  EVALUATOR_ARTIFACT_EVENT_ID,
  EVALUATOR_ARTIFACT_PERSON_ID,
  EVALUATOR_ARTIFACT_WORKSPACE_ID,
} from "../../src/server/services/evaluator-speaker-identity";
import { createSyntheticSpeakerOperationsRepository } from "../../src/server/services/speaker-operations";
import {
  resolveCurrentPublicAgendaRelease,
  resolveExactPublicAgendaRelease,
} from "../../src/server/services/public-widgets";
import {
  publicArtifactReference,
  publicPersonReference,
  publicReleaseReference,
} from "../../src/server/services/public-reference";

const AT = "2026-08-12T12:00:00.000Z";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function pdfFixture(): Buffer {
  const header = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "ascii");
  const xrefOffset = header.length;
  return Buffer.concat([
    header,
    Buffer.from("xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n", "ascii"),
    Buffer.from(`trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii"),
  ]);
}

const databases: Db[] = [];
const roots: string[] = [];

interface Fixture {
  db: Db;
  readonly root: string;
  readonly store: LocalArtifactStore;
}

function fixture(path = ":memory:"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "sympose-sealed-headshot-r3-"));
  roots.push(root);
  const db = openDb({ path: path === ":memory:" ? path : join(root, path), seed: false });
  databases.push(db);
  seedWorkspaces(db);
  seedEvaluatorDemo(db);
  seedEvaluatorSpeakerTaskFixtures(db);
  return { db, root, store: new LocalArtifactStore({ rootDir: join(root, "artifacts"), clock: () => AT }) };
}

function artifactScope(data: Fixture, taskId: string, kind: "HEADSHOT" | "SLIDES"): SpeakerArtifactScope {
  const requiredTask = kind === "HEADSHOT" ? data.db.prepare(
    "SELECT id FROM speaker_tasks WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND task_kind = 'HEADSHOT' AND required = 1 AND gate = 'PUBLICATION'",
  ).get(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID, EVALUATOR_ARTIFACT_PERSON_ID) as { id: string } : null;
  return {
    workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
    eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    personId: EVALUATOR_ARTIFACT_PERSON_ID,
    taskId: requiredTask?.id ?? taskId,
    kind,
  };
}

function createAndApprove(
  data: Fixture,
  scope: SpeakerArtifactScope,
  input: { readonly bytes: Buffer; readonly mediaType: string; readonly filename: string; readonly gate?: "PUBLICATION" | "OPERATOR_RELEASE" },
): SpeakerArtifactRecord {
  const artifact = createSpeakerArtifactRecord(data.db, scope, {
    bytes: input.bytes,
    mediaType: input.mediaType,
    originalFilename: input.filename,
  }, { store: data.store });
  const version = data.db.prepare(
    `SELECT id, content_hash AS contentHash
       FROM speaker_content_versions
      WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ?
      ORDER BY version DESC LIMIT 1`,
  ).get(scope.workspaceId, scope.eventId, scope.personId, scope.taskId) as { id: string; contentHash: string };
  createSyntheticSpeakerOperationsRepository({ db: data.db, clock: () => AT }).approveContent(
    {
      kind: "organizer",
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    },
    {
      personId: scope.personId,
      taskId: scope.taskId,
      submissionVersionId: version.id,
      submissionContentHash: version.contentHash,
      gate: input.gate ?? "PUBLICATION",
      idempotencyKey: `approve:${scope.taskId}:${artifact.version}:${input.gate ?? "PUBLICATION"}`,
    },
  );
  return artifact;
}

function latestVersion(
  db: Db,
  scope: SpeakerArtifactScope,
): { readonly id: string; readonly contentHash: string } {
  return db.prepare(
    `SELECT id, content_hash AS contentHash
       FROM speaker_content_versions
      WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND task_id = ? AND kind = ?
      ORDER BY version DESC LIMIT 1`,
  ).get(scope.workspaceId, scope.eventId, scope.personId, scope.taskId, scope.kind) as {
    id: string;
    contentHash: string;
  };
}

function organizerRepository(data: Fixture) {
  return createSyntheticSpeakerOperationsRepository({ db: data.db, clock: () => AT });
}

function releaseRow(db: Db, releaseId: string): { readonly fingerprint: string; readonly content: SealedReleaseContent; readonly sealedAt: string } {
  const row = db.prepare(
    "SELECT fingerprint, content_json AS contentJson, sealed_at AS sealedAt FROM publication_releases WHERE id = ?",
  ).get(releaseId) as { fingerprint: string; contentJson: string; sealedAt: string };
  return { fingerprint: row.fingerprint, content: JSON.parse(row.contentJson) as SealedReleaseContent, sealedAt: row.sealedAt };
}

function publicationFootprint(db: Db): Record<string, unknown> {
  return db.prepare(
    `SELECT event_row.current_release_id AS currentReleaseId,
            (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = event_row.workspace_id AND event_id = event_row.id) AS releases,
            (SELECT COUNT(*) FROM personal_agendas WHERE workspace_id = event_row.workspace_id) AS agendas,
            (SELECT COUNT(*) FROM portal_tokens WHERE workspace_id = event_row.workspace_id) AS tokens,
            (SELECT COUNT(*) FROM speaker_artifact_release_bindings WHERE workspace_id = event_row.workspace_id AND event_id = event_row.id) AS publicBindings
       FROM events event_row WHERE event_row.workspace_id = ? AND event_row.id = ?`,
  ).get(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID) as Record<string, unknown>;
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("R3 sealed headshot authority", () => {
  it("fails atomically when the required publication artifact is absent", () => {
    const data = fixture();
    const before = publicationFootprint(data.db);
    expect(() => sealRelease(data.db, EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    })).toThrow(/PUBLICATION_ARTIFACT_NOT_READY/u);
    expect(publicationFootprint(data.db)).toEqual(before);
  });

  it("fingerprints an approval made before the current seal and creates its binding atomically", () => {
    const data = fixture();
    const scope = artifactScope(data, "approve-before-seal-headshot", "HEADSHOT");
    const artifact = createSpeakerArtifactRecord(data.db, scope, {
      bytes: PNG,
      mediaType: "image/png",
      originalFilename: "approve-before-seal.png",
    }, { store: data.store });
    const version = data.db.prepare(
      "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE task_id = ?",
    ).get(scope.taskId) as { id: string; contentHash: string };
    const repository = createSyntheticSpeakerOperationsRepository({ db: data.db, clock: () => AT });
    repository.approveContent(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "approve-before-current-seal",
      },
    );
    expect(data.db.prepare(
      "SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE artifact_id = ?",
    ).get(artifact.artifactId)).toEqual({ count: 0 });

    const sealed = sealRelease(data.db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    const row = releaseRow(data.db, sealed.releaseId);
    expect(row.fingerprint).toBe(fingerprintOf(row.content));
    expect(row.content.speakerHeadshots).toEqual([
      expect.objectContaining({
        personId: scope.personId,
        taskId: scope.taskId,
        artifactId: artifact.artifactId,
        version: 1,
        contentHash: version.contentHash,
        sha256: artifact.sha256,
      }),
    ]);
    expect(data.db.prepare(
      `SELECT artifact_id AS artifactId, content_hash AS contentHash, bound_at AS boundAt
         FROM speaker_artifact_release_bindings WHERE release_id = ?`,
    ).get(sealed.releaseId)).toEqual({ artifactId: artifact.artifactId, contentHash: version.contentHash, boundAt: row.sealedAt });
    const currentReleaseId = sealed.releaseId;
    const personReference = publicPersonReference({
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: currentReleaseId,
    }, scope.personId);
    expect(resolveCurrentPublicAgendaRelease(data.db, {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
    }, "approve-before-seal")?.speakers.find((speaker) => speaker.publicReference === personReference)?.photoUrl)
      .toContain("aud1-");
  });

  it("leaves an already sealed release byte-for-byte unchanged after approval", () => {
    const data = fixture();
    const initial = data.db.prepare(
      `SELECT release_row.id, release_row.fingerprint, release_row.content_json AS contentJson
         FROM events event_row JOIN publication_releases release_row ON release_row.id = event_row.current_release_id
        WHERE event_row.workspace_id = ? AND event_row.id = ?`,
    ).get(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID) as { id: string; fingerprint: string; contentJson: string };
    const artifact = createAndApprove(data, artifactScope(data, "approve-after-seal-headshot", "HEADSHOT"), {
      bytes: PNG,
      mediaType: "image/png",
      filename: "approve-after-seal.png",
    });

    expect(data.db.prepare(
      "SELECT fingerprint, content_json AS contentJson FROM publication_releases WHERE id = ?",
    ).get(initial.id)).toEqual({ fingerprint: initial.fingerprint, contentJson: initial.contentJson });
    expect(data.db.prepare(
      "SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE release_id = ?",
    ).get(initial.id)).toEqual({ count: 0 });
    const oldPersonReference = publicPersonReference({
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      releaseId: initial.id,
    }, EVALUATOR_ARTIFACT_PERSON_ID);
    expect(resolveExactPublicAgendaRelease(data.db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      releaseId: initial.id,
    }, "old-release")?.speakers.find((speaker) => speaker.publicReference === oldPersonReference)?.photoUrl).toBeNull();
    expect(readPublishedSpeakerHeadshotByRelease(data.db, {
      releaseId: initial.id,
      artifactId: artifact.artifactId,
    }, { store: data.store })).toBeNull();
  });

  it("blocks atomically when an exact revision request follows publication approval", () => {
    const data = fixture();
    const scope = artifactScope(data, "revision-after-approval-headshot", "HEADSHOT");
    const artifact = createAndApprove(data, scope, {
      bytes: PNG,
      mediaType: "image/png",
      filename: "revision-after-approval.png",
    });
    const version = latestVersion(data.db, scope);
    organizerRepository(data).requestRevision(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
        reason: "Withdraw this exact headshot before publication.",
        idempotencyKey: "revision-after-publication-approval",
      },
    );

    const before = data.db.prepare(
      "SELECT current_release_id AS releaseId, (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ? AND event_id = ?) AS releaseCount, (SELECT COUNT(*) FROM portal_tokens WHERE workspace_id = ?) AS tokenCount FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.workspaceId, scope.eventId);
    expect(() => sealRelease(data.db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    })).toThrow(/PUBLICATION_ARTIFACT_NOT_READY/u);
    expect(data.db.prepare(
      "SELECT current_release_id AS releaseId, (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ? AND event_id = ?) AS releaseCount, (SELECT COUNT(*) FROM portal_tokens WHERE workspace_id = ?) AS tokenCount FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.workspaceId, scope.eventId)).toEqual(before);
    expect(artifact.artifactId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("blocks on an exact readiness blocker and recovers only with an approved newer version", () => {
    const data = fixture();
    const scope = artifactScope(data, "blocker-after-approval-headshot", "HEADSHOT");
    const artifact = createAndApprove(data, scope, {
      bytes: PNG,
      mediaType: "image/png",
      filename: "blocker-after-approval.png",
    });
    const version = latestVersion(data.db, scope);
    const repository = organizerRepository(data);
    repository.addFinding(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
        severity: "BLOCKER",
        message: "This exact headshot must not be made public.",
        blocksReadiness: true,
        idempotencyKey: "blocker-after-publication-approval",
      },
    );

    const before = data.db.prepare(
      "SELECT current_release_id AS releaseId, (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ? AND event_id = ?) AS releaseCount FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId);
    expect(() => sealRelease(data.db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    })).toThrow(/PUBLICATION_ARTIFACT_NOT_READY/u);
    expect(data.db.prepare(
      "SELECT current_release_id AS releaseId, (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ? AND event_id = ?) AS releaseCount FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId)).toEqual(before);

    const replacement = createSpeakerArtifactRecord(data.db, scope, {
      bytes: PNG,
      mediaType: "image/png",
      originalFilename: "blocker-recovery-v2.png",
    }, { store: data.store });
    const replacementVersion = latestVersion(data.db, scope);
    repository.approveContent(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: replacementVersion.id,
        submissionContentHash: replacementVersion.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "replacement-version-approval",
      },
    );
    const recovered = sealRelease(data.db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    expect(recovered.releaseId).not.toBe((before as { releaseId: string }).releaseId);
    expect(releaseRow(data.db, recovered.releaseId).content.speakerHeadshots).toEqual([
      expect.objectContaining({
        personId: scope.personId,
        artifactId: replacement.artifactId,
        contentVersionId: replacementVersion.id,
        contentHash: replacementVersion.contentHash,
        version: 2,
      }),
    ]);
    expect(readPublishedSpeakerHeadshotByRelease(data.db, {
      releaseId: recovered.releaseId,
      artifactId: replacement.artifactId,
    }, { store: data.store })?.bytes).toEqual(PNG);
  });

  it("does not let a repeated same-version approval clear an exact revision request or write a release", () => {
    const data = fixture();
    const scope = artifactScope(data, "same-version-reapproval-headshot", "HEADSHOT");
    const artifact = createAndApprove(data, scope, {
      bytes: PNG,
      mediaType: "image/png",
      filename: "same-version-reapproval.png",
    });
    const version = latestVersion(data.db, scope);
    const repository = organizerRepository(data);
    repository.requestRevision(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
        reason: "A new immutable version is required.",
        idempotencyKey: "revision-before-repeated-approval",
      },
    );
    const repeated = repository.approveContent(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "repeated-same-version-approval",
      },
    );
    expect(repeated.submissionVersionId).toBe(version.id);

    const before = data.db.prepare(
      "SELECT current_release_id AS releaseId, (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ? AND event_id = ?) AS releaseCount FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId);
    expect(() => sealRelease(data.db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    })).toThrow(/PUBLICATION_ARTIFACT_NOT_READY/u);
    expect(data.db.prepare(
      "SELECT current_release_id AS releaseId, (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ? AND event_id = ?) AS releaseCount FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId)).toEqual(before);
    expect(artifact.artifactId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rolls the release back when its immutable headshot binding cannot be created", () => {
    const data = fixture();
    const scope = artifactScope(data, "atomic-seal-headshot", "HEADSHOT");
    const initial = data.db.prepare(
      "SELECT current_release_id AS releaseId FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId) as { releaseId: string };
    const releaseCount = data.db.prepare(
      "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
    ).get(scope.workspaceId, scope.eventId) as { count: number };
    const artifact = createAndApprove(data, scope, {
      bytes: PNG,
      mediaType: "image/png",
      filename: "atomic-seal.png",
    });
    data.db.exec(
      "CREATE TRIGGER abort_atomic_headshot_binding BEFORE INSERT ON speaker_artifact_release_bindings BEGIN SELECT RAISE(ABORT, 'forced binding failure'); END",
    );

    expect(() => sealRelease(data.db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    })).toThrow(/forced binding failure/u);
    expect(data.db.prepare(
      "SELECT COUNT(*) AS count FROM publication_releases WHERE workspace_id = ? AND event_id = ?",
    ).get(scope.workspaceId, scope.eventId)).toEqual(releaseCount);
    expect(data.db.prepare(
      "SELECT current_release_id AS releaseId FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId)).toEqual(initial);
    expect(data.db.prepare(
      "SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE artifact_id = ?",
    ).get(artifact.artifactId)).toEqual({ count: 0 });
  });

  it("rejects tampered committed bytes and metadata before any release write", () => {
    const bytesCase = fixture();
    const bytesScope = artifactScope(bytesCase, "tampered-bytes-headshot", "HEADSHOT");
    const bytesArtifact = createAndApprove(bytesCase, bytesScope, {
      bytes: PNG,
      mediaType: "image/png",
      filename: "tampered-bytes.png",
    });
    const storage = bytesCase.db.prepare(
      "SELECT storage_filename AS storageFilename FROM artifact_records WHERE id = ?",
    ).get(bytesArtifact.artifactId) as { storageFilename: string };
    const changed = Buffer.from(PNG);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    writeFileSync(join(bytesCase.root, "artifacts", storage.storageFilename), changed);
    const beforeBytes = publicationFootprint(bytesCase.db);
    expect(() => sealRelease(bytesCase.db, bytesScope.workspaceId, bytesScope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    })).toThrow(/PUBLICATION_ARTIFACT_INTEGRITY_INVALID/u);
    expect(publicationFootprint(bytesCase.db)).toEqual(beforeBytes);

    const metadataCase = fixture();
    const metadataScope = artifactScope(metadataCase, "tampered-metadata-headshot", "HEADSHOT");
    const metadataArtifact = createAndApprove(metadataCase, metadataScope, {
      bytes: PNG,
      mediaType: "image/png",
      filename: "tampered-metadata.png",
    });
    metadataCase.db.exec("DROP TRIGGER trg_artifact_records_immutable");
    metadataCase.db.prepare("UPDATE artifact_records SET sha256 = ? WHERE id = ?")
      .run("0".repeat(64), metadataArtifact.artifactId);
    const beforeMetadata = publicationFootprint(metadataCase.db);
    expect(() => sealRelease(metadataCase.db, metadataScope.workspaceId, metadataScope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    })).toThrow(/PUBLICATION_ARTIFACT_(?:CARDINALITY|INTEGRITY)_INVALID/u);
    expect(publicationFootprint(metadataCase.db)).toEqual(beforeMetadata);
  });

  it.each(["workspace_id", "person_id", "task_id"] as const)(
    "rejects a required artifact with substituted %s scope before any release write",
    (column) => {
      const data = fixture();
      const scope = artifactScope(data, `wrong-${column}-headshot`, "HEADSHOT");
      const artifact = createAndApprove(data, scope, {
        bytes: PNG,
        mediaType: "image/png",
        filename: `wrong-${column}.png`,
      });
      const replacement = column === "workspace_id"
        ? (data.db.prepare("SELECT id FROM workspaces WHERE id <> ? ORDER BY id LIMIT 1").get(scope.workspaceId) as { id: string }).id
        : column === "person_id"
          ? (data.db.prepare("SELECT id FROM people WHERE workspace_id = ? AND id <> ? ORDER BY id LIMIT 1").get(scope.workspaceId, scope.personId) as { id: string }).id
          : (data.db.prepare("SELECT id FROM speaker_tasks WHERE workspace_id = ? AND event_id = ? AND task_kind = 'SLIDES' ORDER BY id LIMIT 1").get(scope.workspaceId, scope.eventId) as { id: string }).id;
      data.db.exec("DROP TRIGGER trg_artifact_records_immutable");
      data.db.prepare(`UPDATE artifact_records SET ${column} = ? WHERE id = ?`).run(replacement, artifact.artifactId);
      const before = publicationFootprint(data.db);
      expect(() => sealRelease(data.db, scope.workspaceId, scope.eventId, {
        kind: "account",
        ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
      })).toThrow(/PUBLICATION_ARTIFACT_(?:CARDINALITY|INTEGRITY)_INVALID/u);
      expect(publicationFootprint(data.db)).toEqual(before);
    },
  );

  it("supersedes with the newest approved version, preserves both releases internally, and authorizes only the current anonymous headshot", () => {
    const data = fixture("headshot.sqlite");
    const scope = artifactScope(data, "versioned-sealed-headshot", "HEADSHOT");
    const first = createAndApprove(data, scope, { bytes: PNG, mediaType: "image/png", filename: "headshot-v1.png" });
    const releaseOne = sealRelease(data.db, scope.workspaceId, scope.eventId, { kind: "account", ref: EVALUATOR_ORGANIZER_ACCOUNT_ID });
    const releaseOneBefore = releaseRow(data.db, releaseOne.releaseId);

    const second = createSpeakerArtifactRecord(data.db, scope, {
      bytes: PNG,
      mediaType: "image/png",
      originalFilename: "headshot-v2.png",
    }, { store: data.store });
    expect(releaseRow(data.db, releaseOne.releaseId)).toEqual(releaseOneBefore);
    expect(listPublishedSpeakerHeadshots(data.db, {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: releaseOne.releaseId,
      mode: "HISTORICAL",
    }).map((headshot) => headshot.artifactId)).toEqual([first.artifactId]);

    const beforeUnapproved = data.db.prepare(
      "SELECT current_release_id AS releaseId, (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ? AND event_id = ?) AS releaseCount FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId);
    expect(() => sealRelease(data.db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    })).toThrow(/PUBLICATION_ARTIFACT_NOT_READY/u);
    expect(data.db.prepare(
      "SELECT current_release_id AS releaseId, (SELECT COUNT(*) FROM publication_releases WHERE workspace_id = ? AND event_id = ?) AS releaseCount FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId, scope.workspaceId, scope.eventId)).toEqual(beforeUnapproved);

    const secondVersion = data.db.prepare(
      "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE task_id = ? ORDER BY version DESC LIMIT 1",
    ).get(scope.taskId) as { id: string; contentHash: string };
    createSyntheticSpeakerOperationsRepository({ db: data.db, clock: () => AT }).approveContent(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: secondVersion.id,
        submissionContentHash: secondVersion.contentHash,
        gate: "PUBLICATION",
        idempotencyKey: "approve-versioned-headshot-v2",
      },
    );
    const releaseTwo = sealRelease(data.db, scope.workspaceId, scope.eventId, { kind: "account", ref: EVALUATOR_ORGANIZER_ACCOUNT_ID });
    expect(releaseTwo.releaseId).not.toBe(releaseOne.releaseId);
    expect(releaseRow(data.db, releaseTwo.releaseId).content.speakerHeadshots).toEqual([
      expect.objectContaining({ artifactId: second.artifactId, version: 2, personId: scope.personId }),
    ]);
    const replay = sealRelease(data.db, scope.workspaceId, scope.eventId, { kind: "account", ref: EVALUATOR_ORGANIZER_ACCOUNT_ID });
    expect(replay).toMatchObject({ releaseId: releaseTwo.releaseId, fingerprint: releaseTwo.fingerprint, created: false });
    expect(data.db.prepare(
      "SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE release_id IN (?, ?)",
    ).get(releaseOne.releaseId, releaseTwo.releaseId)).toEqual({ count: 2 });

    const oldDb = data.db;
    closeDb(oldDb);
    databases.splice(databases.indexOf(oldDb), 1);
    data.db = openDb({ path: join(data.root, "headshot.sqlite"), seed: false });
    databases.push(data.db);
    const reloadedStore = new LocalArtifactStore({ rootDir: join(data.root, "artifacts"), clock: () => AT });
    expect(readPublishedSpeakerHeadshotByRelease(data.db, {
      releaseId: releaseOne.releaseId,
      artifactId: first.artifactId,
    }, { store: reloadedStore })?.record.version).toBe(1);
    expect(readPublishedSpeakerHeadshotByRelease(data.db, {
      releaseId: releaseTwo.releaseId,
      artifactId: second.artifactId,
    }, { store: reloadedStore })?.record.version).toBe(2);
    const releaseOneScope = {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: releaseOne.releaseId,
    } as const;
    const releaseTwoScope = {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: releaseTwo.releaseId,
    } as const;
    expect(readPublishedSpeakerHeadshotByAudienceReference(data.db, {
      releaseReference: publicReleaseReference(releaseOneScope),
      artifactReference: publicArtifactReference(releaseOneScope, first.artifactId),
    }, { store: reloadedStore })).toBeNull();
    expect(readPublishedSpeakerHeadshotByAudienceReference(data.db, {
      releaseReference: publicReleaseReference(releaseTwoScope),
      artifactReference: publicArtifactReference(releaseTwoScope, second.artifactId),
    }, { store: reloadedStore })?.record.version).toBe(2);
    expect(readPublishedSpeakerHeadshotByAudienceReference(data.db, {
      releaseReference: publicReleaseReference(releaseOneScope),
      artifactReference: publicArtifactReference(releaseTwoScope, second.artifactId),
    }, { store: reloadedStore })).toBeNull();
  });

  it("seals a required publication slide as a private operator artifact without exposing it publicly", () => {
    const data = fixture();
    const headshotScope = artifactScope(data, "required-private-slide-headshot", "HEADSHOT");
    const headshot = createAndApprove(data, headshotScope, {
      bytes: PNG,
      mediaType: "image/png",
      filename: "required-private-slide-headshot.png",
    });
    const assignment = data.db.prepare(
      "SELECT assignment_id AS assignmentId FROM speaker_tasks WHERE id = ?",
    ).get(headshotScope.taskId) as { assignmentId: string };
    const slidesTaskId = "required-private-publication-slides";
    data.db.prepare(
      `INSERT INTO speaker_tasks
         (id, workspace_id, event_id, person_id, assignment_id, task_kind, content_kind,
          title, required, gate, owner, state, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'SLIDES', 'SLIDES', ?, 1, 'PUBLICATION', 'SPEAKER', 'NOT_STARTED', ?, ?, ?)`,
    ).run(
      slidesTaskId,
      headshotScope.workspaceId,
      headshotScope.eventId,
      headshotScope.personId,
      assignment.assignmentId,
      "Publication-ready private slides",
      "2026-09-10T17:00:00.000Z",
      AT,
      AT,
    );
    const slidesScope = artifactScope(data, slidesTaskId, "SLIDES");
    const slides = createAndApprove(data, slidesScope, {
      bytes: pdfFixture(),
      mediaType: "application/pdf",
      filename: "required-private-slides.pdf",
      gate: "PUBLICATION",
    });

    const sealed = sealRelease(data.db, headshotScope.workspaceId, headshotScope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    const content = releaseRow(data.db, sealed.releaseId).content;
    expect(content.artifactBindings).toEqual([
      expect.objectContaining({
        assignmentId: expect.any(String),
        taskId: headshotScope.taskId,
        artifactId: headshot.artifactId,
        intent: "PUBLIC_SPEAKER_HEADSHOT",
        mediaType: "image/png",
        byteSize: PNG.byteLength,
      }),
      expect.objectContaining({
        assignmentId: expect.any(String),
        taskId: slidesScope.taskId,
        artifactId: slides.artifactId,
        intent: "PRIVATE_OPERATOR_ARTIFACT",
        mediaType: "application/pdf",
        byteSize: pdfFixture().byteLength,
      }),
    ]);
    expect(content.speakerHeadshots?.map((entry) => entry.artifactId)).toEqual([headshot.artifactId]);
    expect(readPublishedSpeakerHeadshotByRelease(data.db, {
      releaseId: sealed.releaseId,
      artifactId: slides.artifactId,
    }, { store: data.store })).toBeNull();
  });

  it("denies tenant scope, private slides, and a binding that diverges from the sealed manifest", () => {
    const data = fixture();
    const headshot = createAndApprove(data, artifactScope(data, "scoped-public-headshot", "HEADSHOT"), {
      bytes: PNG,
      mediaType: "image/png",
      filename: "scoped-headshot.png",
    });
    const slides = createAndApprove(data, artifactScope(data, "private-slides", "SLIDES"), {
      bytes: pdfFixture(),
      mediaType: "application/pdf",
      filename: "private-slides.pdf",
      gate: "OPERATOR_RELEASE",
    });
    const sealed = sealRelease(data.db, EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    expect(releaseRow(data.db, sealed.releaseId).content.speakerHeadshots?.map((entry) => entry.artifactId)).toEqual([headshot.artifactId]);
    expect(data.db.prepare(
      "SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE artifact_id = ?",
    ).get(slides.artifactId)).toEqual({ count: 0 });
    expect(readPublishedSpeakerHeadshot(data.db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      releaseId: sealed.releaseId,
      artifactId: slides.artifactId,
    }, { store: data.store })).toBeNull();
    expect(listPublishedSpeakerHeadshots(data.db, {
      workspaceId: "another-workspace",
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      releaseId: sealed.releaseId,
      mode: "HISTORICAL",
    })).toEqual([]);
    expect(readPublishedSpeakerHeadshot(data.db, {
      workspaceId: "another-workspace",
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      releaseId: sealed.releaseId,
      artifactId: headshot.artifactId,
    }, { store: data.store })).toBeNull();

    data.db.exec("DROP TRIGGER trg_speaker_artifact_release_bindings_immutable");
    data.db.prepare(
      "UPDATE speaker_artifact_release_bindings SET content_hash = ? WHERE release_id = ?",
    ).run("0".repeat(64), sealed.releaseId);
    expect(listPublishedSpeakerHeadshots(data.db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      releaseId: sealed.releaseId,
      mode: "HISTORICAL",
    })).toEqual([]);
    expect(readPublishedSpeakerHeadshotByRelease(data.db, {
      releaseId: sealed.releaseId,
      artifactId: headshot.artifactId,
    }, { store: data.store })).toBeNull();
  });
});
