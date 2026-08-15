import type { Db } from "../db";
import type { FixtureManifest, FixturePerson } from "../seed";
import { canonicalJson, deterministicUuid, fingerprintOf, nowIso, uuid } from "../canonical";

export interface ImportedEvidence {
  sourceRecordId: string;
  personId: string;
  provider: string;
  sourceRef: string;
  version: number;
  linked: boolean;
}

export interface ImportResult {
  workspaceSlug: string;
  manifestRef: string;
  imported: ImportedEvidence[];
  skipped: number;
  personsCreated: number;
  receiptId: string;
  completedAt: string;
}

export interface SourceAdapter {
  readonly kind: string;
  importManifest(workspaceId: string, manifest: FixtureManifest): ImportResult;
}

interface PreparedRecord {
  sourceRef: string;
  recordId: string;
  payload: Record<string, unknown>;
  payloadJson: string;
  person: FixturePerson;
}

interface SourceRecordRow {
  id: string;
  workspaceId: string;
  provider: string;
  sourceRef: string;
  version: number;
  payloadJson: string;
  importedAt: string;
}

interface PersonRow {
  id: string;
}

interface LinkRow {
  id: string;
  personId: string;
}

interface ExistingPreparedRecord extends PreparedRecord {
  existing: SourceRecordRow | null;
  existingPerson: PersonRow | null;
}

interface ConsumptionReceiptRow {
  id: string;
  workspaceId: string;
  actorKind: string;
  actorRef: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detailsJson: string | null;
  createdAt: string;
}

interface VerifiedConsumptionReceipt {
  workspaceSlug: string;
  manifestRef: string;
  imported: ImportedEvidence[];
  skipped: number;
  personsCreated: number;
  receiptId: string;
  completedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || value.trim() !== value) {
    throw new Error("SOURCE_MANIFEST_INVALID");
  }
  return value;
}

function validateManifest(manifest: FixtureManifest): void {
  if (!isRecord(manifest)) {
    throw new Error("SOURCE_MANIFEST_INVALID");
  }
  const manifestKeys = new Set(["workspaceSlug", "provider", "sourceRef", "importedAt", "people"]);
  if (Object.keys(manifest).some((key) => !manifestKeys.has(key))) {
    throw new Error("SOURCE_MANIFEST_INVALID");
  }
  const workspaceSlug = boundedString(manifest.workspaceSlug, 1, 80);
  const provider = boundedString(manifest.provider, 1, 120);
  const sourceRef = boundedString(manifest.sourceRef, 1, 240);
  const importedAt = boundedString(manifest.importedAt, 1, 64);
  if (!/^[a-z0-9-]+$/.test(workspaceSlug) || /[\r\n]/.test(provider) || /[\r\n]/.test(sourceRef)) {
    throw new Error("SOURCE_MANIFEST_INVALID");
  }
  if (!Number.isFinite(Date.parse(importedAt)) || !Array.isArray(manifest.people) || manifest.people.length > 500) {
    throw new Error("SOURCE_MANIFEST_INVALID");
  }

  const seenEmails = new Set<string>();
  for (const person of manifest.people) {
    if (!isRecord(person)) {
      throw new Error("SOURCE_MANIFEST_INVALID");
    }
    const personKeys = new Set([
      "email",
      "fullName",
      "organization",
      "title",
      "expertise",
      "moderatorEligible",
    ]);
    if (Object.keys(person).some((key) => !personKeys.has(key))) {
      throw new Error("SOURCE_MANIFEST_INVALID");
    }
    const email = boundedString(person.email, 3, 320);
    const fullName = boundedString(person.fullName, 1, 200);
    boundedString(person.organization, 1, 200);
    boundedString(person.title, 1, 200);
    if (
      !/^[^@\s]+@[^@\s]+$/.test(email) ||
      email !== email.toLowerCase() ||
      seenEmails.has(email) ||
      !Array.isArray(person.expertise) ||
      person.expertise.length > 32 ||
      typeof person.moderatorEligible !== "boolean"
    ) {
      throw new Error("SOURCE_MANIFEST_DUPLICATE_OR_INVALID_IDENTITY");
    }
    seenEmails.add(email);
    for (const expertise of person.expertise) {
      boundedString(expertise, 1, 120);
    }
    if (fullName.length > 200) {
      throw new Error("SOURCE_MANIFEST_INVALID");
    }
  }
}

function canonicalStoredJson(payloadJson: string): string {
  try {
    return canonicalJson(JSON.parse(payloadJson) as unknown);
  } catch {
    throw new Error("SOURCE_RECORD_CONFLICT");
  }
}

function sourceRecordMatches(row: SourceRecordRow, workspaceId: string, provider: string, sourceRef: string, payloadJson: string, importedAt: string): boolean {
  return (
    row.workspaceId === workspaceId &&
    row.provider === provider &&
    row.sourceRef === sourceRef &&
    row.version === 1 &&
    canonicalStoredJson(row.payloadJson) === payloadJson &&
    row.importedAt === importedAt
  );
}

function rollbackSavepoint(db: Db): void {
  try {
    db.exec("ROLLBACK TO SAVEPOINT source_manifest_import");
  } finally {
    db.exec("RELEASE SAVEPOINT source_manifest_import");
  }
}

function isServerTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function receiptCount(details: Record<string, unknown>, key: string): number | null {
  const value = details[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isOpaqueUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function verifyConsumptionReceipt(
  db: Db,
  row: ConsumptionReceiptRow | undefined,
  workspaceId: string,
  manifest: FixtureManifest,
  manifestFingerprint: string,
  receiptId: string,
  adapterKind: string,
): VerifiedConsumptionReceipt {
  if (
    !row ||
    row.id !== receiptId ||
    row.workspaceId !== workspaceId ||
    row.actorKind !== "system" ||
    row.actorRef !== adapterKind ||
    row.action !== "source.import" ||
    row.targetType !== "workspace" ||
    row.targetId !== workspaceId ||
    !row.detailsJson
  ) {
    throw new Error("SOURCE_CONSUMPTION_RECEIPT_INVALID");
  }

  let details: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.detailsJson) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("invalid receipt details");
    }
    details = parsed;
  } catch {
    throw new Error("SOURCE_CONSUMPTION_RECEIPT_INVALID");
  }

  const result = details.result;
  const expectedResultKeys = [
    "workspaceSlug",
    "manifestRef",
    "imported",
    "skipped",
    "personsCreated",
    "receiptId",
    "completedAt",
  ];
  if (
    !isRecord(result) ||
    Object.keys(result).sort().join("|") !== expectedResultKeys.sort().join("|") ||
    !Array.isArray(result.imported)
  ) {
    throw new Error("SOURCE_CONSUMPTION_RECEIPT_INVALID");
  }
  const imported = result.imported;
  const skipped = receiptCount(result, "skipped");
  const personsCreated = receiptCount(result, "personsCreated");
  const completedAt = details.completedAt;
  if (
    result.workspaceSlug !== manifest.workspaceSlug ||
    result.manifestRef !== manifest.sourceRef ||
    result.receiptId !== receiptId ||
    result.completedAt !== completedAt ||
    details.adapter !== adapterKind ||
    details.operation !== "source.import" ||
    details.schema !== "source-consumption/v1" ||
    details.serviceIdentity !== adapterKind ||
    details.manifestRef !== manifest.sourceRef ||
    details.inputFingerprint !== manifestFingerprint ||
    details.receiptId !== receiptId ||
    !isServerTimestamp(completedAt) ||
    row.createdAt !== completedAt ||
    imported.length > manifest.people.length ||
    skipped === null ||
    personsCreated === null ||
    imported.length + skipped !== manifest.people.length ||
    personsCreated > imported.length ||
    details.imported !== imported.length ||
    details.skipped !== skipped ||
    details.personsCreated !== personsCreated
  ) {
    throw new Error("SOURCE_CONSUMPTION_RECEIPT_INVALID");
  }

  const expectedBySourceRef = new Map(
    manifest.people.map((_person, index) => {
      const sourceRef = `${manifest.sourceRef}#row-${index + 1}`;
      return [sourceRef, {
        ordinal: index,
        recordId: deterministicUuid(`source:${manifest.workspaceSlug}:${sourceRef}`),
      }] as const;
    }),
  );
  const sourceRecord = db.prepare(
    `SELECT id, provider, source_ref AS sourceRef, version
     FROM source_records WHERE workspace_id = ? AND id = ?`,
  );
  const sourceLink = db.prepare(
    `SELECT person_id AS personId FROM source_links
     WHERE workspace_id = ? AND source_record_id = ?`,
  );
  const person = db.prepare("SELECT id FROM people WHERE workspace_id = ? AND id = ?");
  const seenSourceRefs = new Set<string>();
  const seenRecordIds = new Set<string>();
  const seenPersonIds = new Set<string>();
  let previousOrdinal = -1;
  for (const entry of imported) {
    if (!isRecord(entry)) {
      throw new Error("SOURCE_CONSUMPTION_RECEIPT_INVALID");
    }
    const entryKeys = ["sourceRecordId", "personId", "provider", "sourceRef", "version", "linked"];
    if (Object.keys(entry).sort().join("|") !== entryKeys.sort().join("|") || entry.linked !== true) {
      throw new Error("SOURCE_CONSUMPTION_RECEIPT_INVALID");
    }
    const expected = expectedBySourceRef.get(entry.sourceRef as string);
    if (
      typeof entry.sourceRef !== "string" ||
      expected === undefined ||
      expected.ordinal <= previousOrdinal ||
      entry.sourceRecordId !== expected.recordId ||
      !isOpaqueUuid(entry.sourceRecordId) ||
      !isOpaqueUuid(entry.personId) ||
      entry.provider !== manifest.provider ||
      entry.version !== 1 ||
      seenSourceRefs.has(entry.sourceRef) ||
      seenRecordIds.has(entry.sourceRecordId) ||
      seenPersonIds.has(entry.personId)
    ) {
      throw new Error("SOURCE_CONSUMPTION_RECEIPT_INVALID");
    }
    const persistedRecord = sourceRecord.get(workspaceId, entry.sourceRecordId) as
      | { id: string; provider: string; sourceRef: string; version: number }
      | undefined;
    const persistedLink = sourceLink.get(workspaceId, entry.sourceRecordId) as { personId: string } | undefined;
    const persistedPerson = person.get(workspaceId, entry.personId) as { id: string } | undefined;
    if (
      !persistedRecord ||
      persistedRecord.provider !== entry.provider ||
      persistedRecord.sourceRef !== entry.sourceRef ||
      persistedRecord.version !== entry.version ||
      !persistedLink ||
      persistedLink.personId !== entry.personId ||
      !persistedPerson
    ) {
      throw new Error("SOURCE_CONSUMPTION_RECEIPT_INVALID");
    }
    seenSourceRefs.add(entry.sourceRef);
    seenRecordIds.add(entry.sourceRecordId);
    seenPersonIds.add(entry.personId);
    previousOrdinal = expected.ordinal;
  }

  return {
    workspaceSlug: result.workspaceSlug,
    manifestRef: result.manifestRef,
    imported: imported as unknown as ImportedEvidence[],
    skipped,
    personsCreated,
    receiptId,
    completedAt,
  };
}

/**
 * Explicit simulated source adapter. The fixture is evidence, while canonical people and
 * links are resolved inside one bounded, replay-safe transaction.
 */
export class SimulatedFixtureSourceAdapter implements SourceAdapter {
  readonly kind = "fixture-import.simulated";
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  importManifest(workspaceId: string, manifest: FixtureManifest): ImportResult {
    validateManifest(manifest);
    const manifestFingerprint = fingerprintOf(manifest);
    const receiptId = deterministicUuid(
      `audit:source.import:${workspaceId}:${this.kind}:${manifestFingerprint}`,
    );
    const workspace = this.db
      .prepare("SELECT slug FROM workspaces WHERE id = ?")
      .get(workspaceId) as { slug: string } | undefined;
    if (!workspace || workspace.slug !== manifest.workspaceSlug) {
      throw new Error("SOURCE_WORKSPACE_MISMATCH");
    }

    const prepared = manifest.people.map((person, index): PreparedRecord => {
      const sourceRef = `${manifest.sourceRef}#row-${index + 1}`;
      const payload = {
        provider: manifest.provider,
        sourceRef,
        version: 1,
        record: {
          email: person.email,
          fullName: person.fullName,
          organization: person.organization,
          title: person.title,
          expertise: person.expertise,
          moderatorEligible: person.moderatorEligible,
        },
        provenance: {
          file: manifest.sourceRef,
          row: index + 1,
          importedAt: manifest.importedAt,
        },
      } satisfies Record<string, unknown>;
      const payloadJson = canonicalJson(payload);
      if (payloadJson.length > 16_000) {
        throw new Error("SOURCE_MANIFEST_PAYLOAD_TOO_LARGE");
      }
      return {
        sourceRef,
        recordId: deterministicUuid(`source:${manifest.workspaceSlug}:${sourceRef}`),
        payload,
        payloadJson,
        person,
      };
    });

    const findByIdentity = this.db.prepare(
      `SELECT id, workspace_id AS workspaceId, provider, source_ref AS sourceRef, version,
              payload_json AS payloadJson, imported_at AS importedAt
       FROM source_records
       WHERE workspace_id = ? AND provider = ? AND source_ref = ? AND version = 1`,
    );
    const findById = this.db.prepare(
      `SELECT id, workspace_id AS workspaceId, provider, source_ref AS sourceRef, version,
              payload_json AS payloadJson, imported_at AS importedAt
       FROM source_records WHERE workspace_id = ? AND id = ?`,
    );
    const findPerson = this.db.prepare(
      "SELECT id FROM people WHERE workspace_id = ? AND canonical_email = ?",
    );
    const findLink = this.db.prepare(
      "SELECT id, person_id AS personId FROM source_links WHERE workspace_id = ? AND source_record_id = ?",
    );
    const findReceipt = this.db.prepare(
      `SELECT id, workspace_id AS workspaceId, actor_kind AS actorKind, actor_ref AS actorRef,
              action, target_type AS targetType, target_id AS targetId,
              details_json AS detailsJson, created_at AS createdAt
       FROM audit_events WHERE id = ? AND workspace_id = ?`,
    );

    const preflight: ExistingPreparedRecord[] = prepared.map((record) => {
      const existingByIdentity = findByIdentity.get(
        workspaceId,
        manifest.provider,
        record.sourceRef,
      ) as SourceRecordRow | undefined;
      const existingById = findById.get(workspaceId, record.recordId) as SourceRecordRow | undefined;
      if (existingById && (!existingByIdentity || existingById.id !== existingByIdentity.id)) {
        throw new Error("SOURCE_RECORD_IDENTITY_CONFLICT");
      }
      const existing = existingByIdentity ?? null;
      if (existing && existing.id !== record.recordId) {
        throw new Error("SOURCE_RECORD_IDENTITY_CONFLICT");
      }
      if (existing && !sourceRecordMatches(
        existing,
        workspaceId,
        manifest.provider,
        record.sourceRef,
        record.payloadJson,
        manifest.importedAt,
      )) {
        throw new Error("SOURCE_RECORD_CONFLICT");
      }
      const existingPerson = existing
        ? (findPerson.get(workspaceId, record.person.email) as PersonRow | undefined) ?? null
        : null;
      if (existing) {
        const link = findLink.get(workspaceId, existing.id) as LinkRow | undefined;
        if (!existingPerson || !link || link.personId !== existingPerson.id) {
          throw new Error("SOURCE_RECORD_RELATIONSHIP_CONFLICT");
        }
      }
      return { ...record, existing, existingPerson };
    });

    const existingReceipt = findReceipt.get(receiptId, workspaceId) as ConsumptionReceiptRow | undefined;
    const allExisting = preflight.length > 0 && preflight.every((record) => record.existing !== null);
    const replayingEmptyManifest = preflight.length === 0 && existingReceipt !== undefined;
    if (allExisting || replayingEmptyManifest) {
      const receipt = verifyConsumptionReceipt(
        this.db,
        existingReceipt,
        workspaceId,
        manifest,
        manifestFingerprint,
        receiptId,
        this.kind,
      );
      return receipt;
    }

    const receivedAt = nowIso();
    this.db.exec("SAVEPOINT source_manifest_import");
    try {
      const imported: ImportedEvidence[] = [];
      let skipped = 0;
      let personsCreated = 0;
      const insertRecord = this.db.prepare(
        `INSERT INTO source_records (id, workspace_id, provider, source_ref, version, payload_json, imported_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      );
      const insertPerson = this.db.prepare(
        `INSERT INTO people (id, workspace_id, canonical_email, full_name, organization, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertLink = this.db.prepare(
        `INSERT INTO source_links (id, workspace_id, person_id, source_record_id, link_decision, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      for (const record of preflight) {
        let existing = record.existing;
        let recordCreated = false;
        if (!existing) {
          try {
            insertRecord.run(
              record.recordId,
              workspaceId,
              manifest.provider,
              record.sourceRef,
              record.payloadJson,
              manifest.importedAt,
            );
            recordCreated = true;
          } catch {
            const racedByIdentity = findByIdentity.get(
              workspaceId,
              manifest.provider,
              record.sourceRef,
            ) as SourceRecordRow | undefined;
            const racedById = findById.get(workspaceId, record.recordId) as SourceRecordRow | undefined;
            existing = racedByIdentity ?? racedById ?? null;
            if (
              !existing ||
              !sourceRecordMatches(
                existing,
                workspaceId,
                manifest.provider,
                record.sourceRef,
                record.payloadJson,
                manifest.importedAt,
              )
            ) {
              throw new Error("SOURCE_RECORD_CONFLICT");
            }
          }
        }
        if (!recordCreated) {
          skipped += 1;
        }

        let personRow = record.existingPerson ?? (findPerson.get(
          workspaceId,
          record.person.email,
        ) as PersonRow | undefined) ?? null;
        if (!personRow) {
          const personId = uuid();
          try {
            insertPerson.run(
              personId,
              workspaceId,
              record.person.email,
              record.person.fullName,
              record.person.organization,
              record.person.title,
              receivedAt,
            );
            personRow = { id: personId };
            personsCreated += 1;
          } catch {
            personRow = (findPerson.get(workspaceId, record.person.email) as PersonRow | undefined) ?? null;
            if (!personRow) {
              throw new Error("SOURCE_PERSON_CONFLICT");
            }
          }
        }

        const sourceRecordId = existing?.id ?? record.recordId;
        const existingLink = findLink.get(workspaceId, sourceRecordId) as LinkRow | undefined;
        if (existingLink) {
          if (existingLink.personId !== personRow.id) {
            throw new Error("SOURCE_LINK_CONFLICT");
          }
        } else {
          try {
            insertLink.run(
              deterministicUuid(`link:${manifest.workspaceSlug}:${record.sourceRef}`),
              workspaceId,
              personRow.id,
              sourceRecordId,
              "auto-resolve",
              receivedAt,
            );
          } catch {
            const racedLink = findLink.get(workspaceId, sourceRecordId) as LinkRow | undefined;
            if (!racedLink || racedLink.personId !== personRow.id) {
              throw new Error("SOURCE_LINK_CONFLICT");
            }
          }
        }

        if (recordCreated) {
          imported.push({
            sourceRecordId,
            personId: personRow.id,
            provider: manifest.provider,
            sourceRef: record.sourceRef,
            version: 1,
            linked: true,
          });
        }
      }

      const auditDetails = {
        adapter: this.kind,
        operation: "source.import",
        schema: "source-consumption/v1",
        serviceIdentity: this.kind,
        manifestRef: manifest.sourceRef,
        inputFingerprint: manifestFingerprint,
        receiptId,
        imported: imported.length,
        skipped,
        personsCreated,
        result: {
          workspaceSlug: manifest.workspaceSlug,
          manifestRef: manifest.sourceRef,
          imported,
          skipped,
          personsCreated,
          receiptId,
          completedAt: receivedAt,
        },
        completedAt: receivedAt,
      };
      const existingAudit = findReceipt.get(receiptId, workspaceId) as ConsumptionReceiptRow | undefined;
      if (existingAudit) {
        const receipt = verifyConsumptionReceipt(
          this.db,
          existingAudit,
          workspaceId,
          manifest,
          manifestFingerprint,
          receiptId,
          this.kind,
        );
        if (imported.length > 0 || personsCreated > 0) {
          throw new Error("SOURCE_CONSUMPTION_RECEIPT_CONFLICT");
        }
        return receipt;
      }
      if (!existingAudit) {
        this.db.prepare(
          `INSERT INTO audit_events (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
           VALUES (?, ?, 'system', ?, 'source.import', 'workspace', ?, ?, ?)`,
        ).run(
          receiptId,
          workspaceId,
          this.kind,
          workspaceId,
          JSON.stringify(auditDetails),
          receivedAt,
        );
      }

      return {
        workspaceSlug: manifest.workspaceSlug,
        manifestRef: manifest.sourceRef,
        imported,
        skipped,
        personsCreated,
        receiptId,
        completedAt: receivedAt,
      };
    } catch (error) {
      rollbackSavepoint(this.db);
      throw error;
    } finally {
      try {
        this.db.exec("RELEASE SAVEPOINT source_manifest_import");
      } catch {
        // The rollback path already released the savepoint.
      }
    }
  }
}
