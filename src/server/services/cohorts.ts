import type { Db } from "../db";
import { fingerprintOf, nowIso, uuid } from "../canonical";
import { withTransaction } from "../db";
import { writeAudit } from "./audit";

function isReceiptTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export interface SnapshotMember {
  personId: string;
  rank: number;
  whyIn: string;
}

export interface CohortSnapshotResult {
  snapshotId: string;
  fingerprint: string;
  memberCount: number;
  created: boolean;
  definition: { id: string; name: string; version: number };
  asOf: string;
}

export function freezeCohortSnapshot(
  db: Db,
  workspaceId: string,
  actor: { kind: "account"; ref: string },
  overrides?: { cohortName?: string; purpose?: string },
): CohortSnapshotResult {
  return withTransaction(db, () => {
    const cohortName = overrides?.cohortName ?? "Roundtable participants (fixture import)";
    const purpose = overrides?.purpose ?? "roundtable participation";

    const people = db
      .prepare(
        `SELECT p.id AS person_id, p.canonical_email, p.full_name, p.organization, p.title, p.created_at
         FROM people p
         WHERE p.workspace_id = ?
           AND EXISTS (
             SELECT 1 FROM source_links l
             WHERE l.workspace_id = p.workspace_id AND l.person_id = p.id
           )
         ORDER BY p.canonical_email`,
      )
      .all(workspaceId) as {
      person_id: string;
      canonical_email: string;
      full_name: string;
      organization: string;
      title: string | null;
      created_at: string;
    }[];

    if (people.length === 0) {
      throw new Error("NO_PEOPLE: import fixture evidence before freezing a cohort snapshot.");
    }

    const linkRows = db
      .prepare(
        `SELECT l.id, l.person_id AS personId, l.source_record_id AS sourceRecordId,
                l.created_at AS createdAt, r.payload_json AS payloadJson, r.source_ref AS sourceRef
         FROM source_links l
         JOIN source_records r
           ON r.id = l.source_record_id AND r.workspace_id = l.workspace_id
         WHERE l.workspace_id = ?
         ORDER BY l.person_id, l.created_at, l.id`,
      )
      .all(workspaceId) as {
      id: string;
      personId: string;
      sourceRecordId: string;
      createdAt: string;
      payloadJson: string;
      sourceRef: string;
    }[];

    if (linkRows.length === 0) {
      throw new Error("COHORT_LINK_RECEIPT_INVALID");
    }
    const peopleIds = new Set(people.map((person) => person.person_id));
    const seenLinkIds = new Set<string>();
    const seenSourceRecordIds = new Set<string>();
    for (const link of linkRows) {
      if (
        !peopleIds.has(link.personId) ||
        !isReceiptTimestamp(link.createdAt) ||
        seenLinkIds.has(link.id) ||
        seenSourceRecordIds.has(link.sourceRecordId)
      ) {
        throw new Error("COHORT_LINK_RECEIPT_INVALID");
      }
      seenLinkIds.add(link.id);
      seenSourceRecordIds.add(link.sourceRecordId);
    }
    if (peopleIds.size !== new Set(linkRows.map((link) => link.personId)).size) {
      throw new Error("COHORT_LINK_RECEIPT_INVALID");
    }

    const receiptOrder = [...linkRows].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const latestReceipt = receiptOrder.pop();
    if (!latestReceipt) {
      throw new Error("COHORT_LINK_RECEIPT_INVALID");
    }
    const asOf = latestReceipt.createdAt;

    const evidenceByPerson = new Map<string, { sourceRefs: string[]; expertise: string[] }>();
    for (const link of linkRows) {
      let payload: { record?: { expertise?: string[] } } = {};
      try {
        payload = JSON.parse(link.payloadJson) as { record?: { expertise?: string[] } };
        if (!Array.isArray(payload.record?.expertise)) {
          throw new Error("invalid evidence payload");
        }
      } catch {
        throw new Error("COHORT_LINK_RECEIPT_INVALID");
      }
      const entry = evidenceByPerson.get(link.personId) ?? { sourceRefs: [], expertise: [] };
      entry.sourceRefs.push(link.sourceRef);
      const expertise = payload.record?.expertise ?? [];
      entry.expertise.push(...expertise);
      evidenceByPerson.set(link.personId, entry);
    }

    const members: SnapshotMember[] = people
      .map((person) => {
        const evidence = evidenceByPerson.get(person.person_id);
        if (!evidence || evidence.sourceRefs.length === 0) {
          throw new Error("COHORT_LINK_RECEIPT_INVALID");
        }
        const expertise = evidence.expertise;
        const sourceRefs = evidence.sourceRefs;
        return {
          personId: person.person_id,
          email: person.canonical_email,
          rank: 0,
          whyIn:
            `Matched purpose "${purpose}": imported evidence at ${sourceRefs.join(", ") || "unknown source"} ` +
            (expertise.length > 0 ? `with expertise [${expertise.join(", ")}].` : "with no recorded expertise."),
          expertiseCount: expertise.length,
        };
      })
      .sort(
        (a, b) =>
          b.expertiseCount - a.expertiseCount ||
          a.personId.localeCompare(b.personId) ||
          a.email.localeCompare(b.email),
      )
      .map((member, index) => ({ personId: member.personId, rank: index + 1, whyIn: member.whyIn }));

    const definitionJson = JSON.stringify({
      name: cohortName,
      version: 1,
      purpose,
      rule: {
        eligibleEntity: "person",
        criteria: "Canonical people with fixture source evidence in this workspace.",
        missingDataPolicy: "People without any linked source evidence are excluded.",
        asOf,
      },
    });

    const fingerprint = fingerprintOf({
      schema: "cohort-snapshot/v1",
      workspaceId,
      cohortName,
      definitionVersion: 1,
      asOf,
      members: members.map((m) => ({ personId: m.personId, rank: m.rank, whyIn: m.whyIn })),
    });

    const existing = db
      .prepare(
        `SELECT s.id, s.cohort_definition_id AS definitionId, d.name AS definitionName,
                s.definition_version AS definitionVersion, s.member_count AS memberCount, s.as_of AS asOf
         FROM cohort_snapshots s
         JOIN cohort_definitions d
           ON d.id = s.cohort_definition_id AND d.workspace_id = s.workspace_id
         WHERE s.workspace_id = ? AND s.fingerprint = ?`,
      )
      .get(workspaceId, fingerprint) as
      | {
          id: string;
          definitionId: string;
          definitionName: string;
          definitionVersion: number;
          memberCount: number;
          asOf: string;
        }
      | undefined;
    if (existing) {
      return {
        snapshotId: existing.id,
        fingerprint,
        memberCount: existing.memberCount,
        created: false,
        definition: {
          id: existing.definitionId,
          name: existing.definitionName,
          version: existing.definitionVersion,
        },
        asOf: existing.asOf,
      };
    }

    const definitionId = uuid();
    db.prepare(
      `INSERT INTO cohort_definitions (id, workspace_id, name, version, definition_json, created_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(definitionId, workspaceId, cohortName, definitionJson, nowIso());

    const snapshotId = uuid();
    db.prepare(
      `INSERT INTO cohort_snapshots (id, workspace_id, cohort_definition_id, definition_version, as_of, fingerprint, member_count, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(snapshotId, workspaceId, definitionId, asOf, fingerprint, members.length, nowIso());

    const insertMember = db.prepare(
      `INSERT INTO cohort_snapshot_members (id, workspace_id, snapshot_id, person_id, rank, why_in)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const member of members) {
      insertMember.run(uuid(), workspaceId, snapshotId, member.personId, member.rank, member.whyIn);
    }

    writeAudit(db, workspaceId, {
      actorKind: actor.kind,
      actorRef: actor.ref,
      action: "cohort.snapshot.frozen",
      targetType: "cohort_snapshot",
      targetId: snapshotId,
      details: { fingerprint, memberCount: members.length, asOf },
    });

    return {
      snapshotId,
      fingerprint,
      memberCount: members.length,
      created: true,
      definition: { id: definitionId, name: cohortName, version: 1 },
      asOf,
    };
  });
}

export function latestSnapshot(db: Db, workspaceId: string): {
  id: string;
  fingerprint: string;
  memberCount: number;
  asOf: string;
  createdAt: string;
} | null {
  const row = db
    .prepare(
      `SELECT id, fingerprint, member_count AS memberCount, as_of AS asOf, created_at AS createdAt
       FROM cohort_snapshots WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workspaceId) as
    | { id: string; fingerprint: string; memberCount: number; asOf: string; createdAt: string }
    | undefined;
  return row ?? null;
}
