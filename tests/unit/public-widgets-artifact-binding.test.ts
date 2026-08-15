import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import { fingerprintOf } from "../../src/server/canonical";
import {
  EVALUATOR_ORGANIZER_ACCOUNT_ID,
  seedEvaluatorDemo,
  seedEvaluatorSpeakerTaskFixtures,
} from "../../src/server/evaluator-demo";
import { seedWorkspaces } from "../../src/server/seed";
import {
  createSpeakerArtifactRecord,
  readPublishedSpeakerHeadshotByAudienceReference,
  type SpeakerArtifactScope,
} from "../../src/server/services/artifact-records";
import { LocalArtifactStore } from "../../src/server/services/artifact-store";
import { sealRelease, type SealedReleaseContent } from "../../src/server/services/publication";
import { createSyntheticSpeakerOperationsRepository } from "../../src/server/services/speaker-operations";
import {
  resolveCurrentPublicAgendaRelease,
  resolveCurrentPublicWidgetBinding,
} from "../../src/server/services/public-widgets";
import { publicArtifactReference, publicPersonReference, publicReleaseReference } from "../../src/server/services/public-reference";
import {
  EVALUATOR_ARTIFACT_EVENT_ID,
  EVALUATOR_ARTIFACT_PERSON_ID,
  EVALUATOR_ARTIFACT_WORKSPACE_ID,
} from "../../src/server/services/evaluator-speaker-identity";

const AT = "2026-08-12T12:00:00.000Z";
const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const databases: Db[] = [];
const paths: string[] = [];

function requiredHeadshotTaskId(db: Db): string {
  const row = db.prepare(
    "SELECT id FROM speaker_tasks WHERE workspace_id = ? AND event_id = ? AND person_id = ? AND task_kind = 'HEADSHOT' AND required = 1 AND gate = 'PUBLICATION'",
  ).get(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID, EVALUATOR_ARTIFACT_PERSON_ID) as { id: string };
  return row.id;
}

afterEach(() => {
  for (const db of databases.splice(0)) closeDb(db);
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("public widget speaker artifact binding", () => {
  it("resolves the sealed v2 release using canonical accepted person IDs", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    expect(resolveCurrentPublicWidgetBinding(db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    })).toBeNull();
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    seedEvaluatorSpeakerTaskFixtures(db);

    const currentRelease = db.prepare(
      "SELECT current_release_id AS releaseId FROM events WHERE workspace_id = ? AND id = ?",
    ).get(EVALUATOR_ARTIFACT_WORKSPACE_ID, EVALUATOR_ARTIFACT_EVENT_ID) as { releaseId: string };
    const referenceScope = {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      releaseId: currentRelease.releaseId,
    } as const;
    const releaseReference = publicReleaseReference(referenceScope);
    const published = resolveCurrentPublicAgendaRelease(db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    }, releaseReference);
    const binding = resolveCurrentPublicWidgetBinding(db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    });
    const personReference = publicPersonReference({
      ...referenceScope,
    }, EVALUATOR_ARTIFACT_PERSON_ID);

    expect(published).not.toBeNull();
    expect(binding).toMatchObject({
      releaseReference,
      widget: {
        event: { publicReference: releaseReference },
        release: {
          channelReference: releaseReference,
          releaseReference,
        },
      },
    });
    expect(binding?.widget.sessions.length).toBeGreaterThan(0);
    expect(binding?.widget.speakers.length).toBeGreaterThan(0);
    expect(JSON.stringify(binding)).not.toContain(currentRelease.releaseId);
    expect(resolveCurrentPublicWidgetBinding(db, {
      workspaceId: "workspace-cross-tenant",
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    })).toBeNull();
    expect(published?.speakers.some((speaker) => speaker.publicReference === personReference)).toBe(true);
    expect(published?.speakers.every((speaker) => speaker.photoUrl === null)).toBe(true);
  });

  it("keeps a later approval off the old release and projects it only after a new fingerprint-bound seal", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    seedEvaluatorSpeakerTaskFixtures(db);
    const root = mkdtempSync(join(tmpdir(), "sympose-widget-artifacts-"));
    paths.push(root);
    const store = new LocalArtifactStore({ rootDir: root, clock: () => AT });
    const scope: SpeakerArtifactScope = {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: requiredHeadshotTaskId(db),
      kind: "HEADSHOT",
    };
    const artifact = createSpeakerArtifactRecord(db, scope, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "mina-public.png",
    }, { store });
    const version = db.prepare(
      "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE task_id = ?",
    ).get(scope.taskId) as { id: string; contentHash: string };
    const repository = createSyntheticSpeakerOperationsRepository({ db, clock: () => AT });
    const oldRelease = db.prepare(
      "SELECT current_release_id AS releaseId FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId) as { releaseId: string };
    repository.approveContent(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
        gate: "PUBLICATION",
      },
    );

    const oldReleaseReference = publicReleaseReference({
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: oldRelease.releaseId,
    });
    const unchanged = resolveCurrentPublicAgendaRelease(db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    }, oldReleaseReference);
    expect(unchanged?.releaseId).toBe(oldRelease.releaseId);
    const oldPersonReference = publicPersonReference({
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: oldRelease.releaseId,
    }, scope.personId);
    expect(unchanged?.speakers.find((speaker) => speaker.publicReference === oldPersonReference)?.photoUrl).toBeNull();
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM speaker_artifact_release_bindings WHERE release_id = ?",
    ).get(oldRelease.releaseId)).toEqual({ count: 0 });

    const sealed = sealRelease(db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    const row = db.prepare(
      "SELECT content_json AS contentJson, fingerprint FROM publication_releases WHERE id = ?",
    ).get(sealed.releaseId) as { contentJson: string; fingerprint: string };
    const content = JSON.parse(row.contentJson) as SealedReleaseContent;
    expect(sealed.releaseId).not.toBe(oldRelease.releaseId);
    expect(row.fingerprint).toBe(fingerprintOf(content));
    expect(content.speakerHeadshots).toEqual([
      expect.objectContaining({ personId: scope.personId, artifactId: artifact.artifactId, version: 1 }),
    ]);

    const newReferenceScope = {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: sealed.releaseId,
    } as const;
    const newPersonReference = publicPersonReference(newReferenceScope, scope.personId);
    const newReleaseReference = publicReleaseReference(newReferenceScope);
    const newArtifactReference = publicArtifactReference(newReferenceScope, artifact.artifactId);
    const published = resolveCurrentPublicAgendaRelease(db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    }, newReleaseReference);
    const binding = resolveCurrentPublicWidgetBinding(db, {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
    });
    expect(binding?.releaseReference).toBe(newReleaseReference);
    expect(binding?.releaseReference).not.toBe(oldReleaseReference);
    expect(published).not.toBeNull();
    expect(published?.speakers.find((speaker) => speaker.publicReference === newPersonReference)?.photoUrl)
      .toBe(`/public/releases/${encodeURIComponent(newReleaseReference)}/speaker-artifacts/${encodeURIComponent(newArtifactReference)}`);
  });

  it("serves only the exact current release/artifact reference and fails closed for stale or cross-release pairs", () => {
    const db = openDb({ path: ":memory:", seed: false });
    databases.push(db);
    seedWorkspaces(db);
    seedEvaluatorDemo(db);
    seedEvaluatorSpeakerTaskFixtures(db);
    const root = mkdtempSync(join(tmpdir(), "sympose-widget-artifacts-safe-read-"));
    paths.push(root);
    const store = new LocalArtifactStore({ rootDir: root, clock: () => AT });
    const scope: SpeakerArtifactScope = {
      workspaceId: EVALUATOR_ARTIFACT_WORKSPACE_ID,
      eventId: EVALUATOR_ARTIFACT_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      taskId: requiredHeadshotTaskId(db),
      kind: "HEADSHOT",
    };
    const artifact = createSpeakerArtifactRecord(db, scope, {
      bytes: PNG_FIXTURE,
      mediaType: "image/png",
      originalFilename: "safe-read.png",
    }, { store });
    const version = db.prepare(
      "SELECT id, content_hash AS contentHash FROM speaker_content_versions WHERE task_id = ?",
    ).get(scope.taskId) as { id: string; contentHash: string };
    const repository = createSyntheticSpeakerOperationsRepository({ db, clock: () => AT });
    repository.approveContent(
      { kind: "organizer", workspaceId: scope.workspaceId, eventId: scope.eventId, actorId: EVALUATOR_ORGANIZER_ACCOUNT_ID },
      {
        personId: scope.personId,
        taskId: scope.taskId,
        submissionVersionId: version.id,
        submissionContentHash: version.contentHash,
        gate: "PUBLICATION",
      },
    );
    const oldRelease = db.prepare(
      "SELECT current_release_id AS releaseId FROM events WHERE workspace_id = ? AND id = ?",
    ).get(scope.workspaceId, scope.eventId) as { releaseId: string };
    const sealed = sealRelease(db, scope.workspaceId, scope.eventId, {
      kind: "account",
      ref: EVALUATOR_ORGANIZER_ACCOUNT_ID,
    });
    const currentScope = {
      workspaceId: scope.workspaceId,
      eventId: scope.eventId,
      releaseId: sealed.releaseId,
    } as const;
    const releaseReference = publicReleaseReference(currentScope);
    const artifactReference = publicArtifactReference(currentScope, artifact.artifactId);
    const read = readPublishedSpeakerHeadshotByAudienceReference(db, {
      releaseReference,
      artifactReference,
    }, { store });
    expect(read?.bytes).toEqual(PNG_FIXTURE);
    expect(readPublishedSpeakerHeadshotByAudienceReference(db, {
      releaseReference: publicReleaseReference({ ...currentScope, releaseId: oldRelease.releaseId }),
      artifactReference,
    }, { store })).toBeNull();
    expect(readPublishedSpeakerHeadshotByAudienceReference(db, {
      releaseReference,
      artifactReference: publicArtifactReference({ ...currentScope, releaseId: oldRelease.releaseId }, artifact.artifactId),
    }, { store })).toBeNull();
    expect(readPublishedSpeakerHeadshotByAudienceReference(db, {
      releaseReference,
      artifactReference: "aud1-99999999-9999-4999-8999-999999999999",
    }, { store })).toBeNull();
  });
});
