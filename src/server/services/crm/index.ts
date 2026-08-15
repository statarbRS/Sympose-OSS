import { canonicalJson, deterministicUuid, fingerprintOf, nowIso } from "../../canonical";
import { withTransaction, type Db } from "../../db";
import {
  assertWorkspaceMatch,
  requireCapability,
  type SessionInfo,
} from "../../auth";
import {
  CRM_CSV_HEADER,
  CRM_CSV_MAX_BYTES,
  CRM_CSV_MAX_FIELD_LENGTH,
  CRM_CSV_MAX_ROWS,
  CRM_CSV_PROVIDER,
  CRM_CSV_SCHEMA,
} from "./contracts";

export {
  CRM_CSV_HEADER,
  CRM_CSV_MAX_BYTES,
  CRM_CSV_MAX_FIELD_LENGTH,
  CRM_CSV_MAX_ROWS,
  CRM_CSV_PROVIDER,
  CRM_CSV_SCHEMA,
} from "./contracts";

const CRM_CSV_ALTERNATE_HEADER = ["full_name", "email", "organization", "title"] as const;

/**
 * CRM reads are projections around the canonical identity spine. These rows are never CRM-owned
 * contact roots, and the service intentionally accepts a verified session rather than a caller
 * supplied workspace id.
 */
export interface CrmPersonSummary {
  id: string;
  canonicalEmail: string;
  fullName: string;
  organization: string | null;
  title: string | null;
  sourceCount: number;
}

export interface CrmDirectoryMetrics {
  totalPeople: number;
  organizations: number;
  withOrganization: number;
  withTitle: number;
  sourcedPeople: number;
}

export interface CrmWorkspaceView {
  workspace: {
    id: string;
    slug: string;
    name: string;
  };
  people: CrmPersonSummary[];
  metrics: CrmDirectoryMetrics;
}

export type CrmCsvPreviewDisposition = "CREATE" | "MERGE_CANDIDATE" | "REJECTED";
export type CrmCsvReceiptStatus = "CREATED" | "MERGED" | "REJECTED";

export interface CrmCsvPreviewRow {
  rowNumber: number;
  email: string;
  fullName: string;
  organization: string | null;
  title: string | null;
  normalizedEmail: string | null;
  normalizedName: string | null;
  disposition: CrmCsvPreviewDisposition;
  matchPersonId?: string;
  matchPersonName?: string;
  matchReason?: "EMAIL_EXACT" | "NAME_NORMALIZED_CANDIDATE";
  reason?: string;
}

export interface CrmCsvPreview {
  schema: typeof CRM_CSV_SCHEMA;
  header: typeof CRM_CSV_HEADER[number][];
  inputFingerprint: string;
  rows: CrmCsvPreviewRow[];
  createCount: number;
  mergeCandidateCount: number;
  rejectedCount: number;
  requiresConfirmation: boolean;
}

export interface CrmCsvReceiptRow {
  rowNumber: number;
  status: CrmCsvReceiptStatus;
  email: string;
  fullName: string;
  personId?: string;
  reason?: string;
}

export interface CrmCsvImportReceipt {
  schema: typeof CRM_CSV_SCHEMA;
  receiptId: string;
  inputFingerprint: string;
  completedAt: string;
  createdCount: number;
  mergedCount: number;
  rejectedCount: number;
  canonicalWrites: true;
  provenance: {
    provider: typeof CRM_CSV_PROVIDER;
    sourceRecordCount: number;
    sourceLinkCount: number;
  };
  rows: CrmCsvReceiptRow[];
}

export interface CrmCsvActionState {
  ok: boolean;
  code?: string;
  message: string;
  denial?: { code: string; message: string; target: string };
  preview?: CrmCsvPreview;
  receipt?: CrmCsvImportReceipt;
}

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
}

interface PersonRow {
  id: string;
  canonicalEmail: string;
  fullName: string;
  organization: string | null;
  title: string | null;
  sourceCount: number;
}

interface ExistingPersonIdentity {
  id: string;
  canonicalEmail: string;
  fullName: string;
}

interface ParsedCsv {
  records: string[][];
  inputFingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normaliseCell(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function normalizeCrmEmail(value: string): string {
  return normaliseCell(value).toLocaleLowerCase("en-US");
}

export function normalizeCrmName(value: string): string {
  return normaliseCell(value).toLocaleLowerCase("en-US");
}

function isSyntheticEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return (
    domain === "example.com" ||
    domain === "example.test" ||
    domain.endsWith(".example") ||
    domain.endsWith(".test") ||
    domain.endsWith(".invalid")
  );
}

function isValidSyntheticEmail(email: string): boolean {
  return (
    email.length >= 3 &&
    email.length <= 320 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email) &&
    isSyntheticEmail(email)
  );
}

function optionalCrmField(value: string): string | null {
  const normalised = normaliseCell(value);
  return normalised.length > 0 ? normalised : null;
}

function csvParseFailure(code: string): never {
  throw new Error(`${code}: the bounded CRM CSV schema could not be parsed.`);
}

function parseCsvRecords(csv: string): string[][] {
  if (typeof csv !== "string" || Buffer.byteLength(csv, "utf8") > CRM_CSV_MAX_BYTES) {
    return csvParseFailure("CRM_CSV_TOO_LARGE");
  }
  if (csv.includes("\0")) {
    return csvParseFailure("CRM_CSV_INVALID");
  }

  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  const pushField = () => {
    record.push(field);
    field = "";
    closedQuote = false;
  };
  const pushRecord = () => {
    if (record.length > 0 && record.some((value) => value.length > 0)) {
      records.push(record);
    }
    record = [];
  };

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (character === "\r" || character === "\n") {
        return csvParseFailure("CRM_CSV_INVALID");
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote) {
      if (character === ",") {
        pushField();
      } else if (character === "\r" || character === "\n") {
        pushField();
        pushRecord();
        if (character === "\r" && csv[index + 1] === "\n") {
          index += 1;
        }
      } else if (character !== " " && character !== "\t") {
        return csvParseFailure("CRM_CSV_INVALID");
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      pushField();
    } else if (character === "\r" || character === "\n") {
      pushField();
      pushRecord();
      if (character === "\r" && csv[index + 1] === "\n") {
        index += 1;
      }
    } else if (character === '"') {
      return csvParseFailure("CRM_CSV_INVALID");
    } else {
      field += character;
    }
  }

  if (quoted) {
    return csvParseFailure("CRM_CSV_INVALID");
  }
  if (field.length > 0 || record.length > 0) {
    pushField();
    pushRecord();
  }
  return records;
}

function parseCrmCsv(csv: string): ParsedCsv {
  const records = parseCsvRecords(csv);
  const header = records.shift()?.map((value) => normaliseCell(value).toLocaleLowerCase("en-US"));
  const headerText = header?.join(",");
  const columnOrder = headerText === CRM_CSV_HEADER.join(",")
    ? [0, 1, 2, 3]
    : headerText === CRM_CSV_ALTERNATE_HEADER.join(",")
      ? [1, 0, 2, 3]
      : null;
  if (!header || !columnOrder) {
    throw new Error(
      `CRM_CSV_HEADER_INVALID: expected ${CRM_CSV_HEADER.join(",")}.`,
    );
  }
  if (records.length > CRM_CSV_MAX_ROWS) {
    throw new Error(`CRM_CSV_TOO_MANY_ROWS: maximum ${CRM_CSV_MAX_ROWS} data rows.`);
  }
  const canonicalRecords = records.map((record) =>
    record.length === CRM_CSV_HEADER.length
      ? columnOrder.map((column) => record[column] ?? "")
      : record,
  );
  return {
    records: canonicalRecords.map((record) => record.map(normaliseCell)),
    inputFingerprint: fingerprintOf({
      schema: CRM_CSV_SCHEMA,
      header: CRM_CSV_HEADER,
      records: canonicalRecords,
    }),
  };
}

function existingPeople(db: Db, workspaceId: string): ExistingPersonIdentity[] {
  return db
    .prepare(
      `SELECT id, canonical_email AS canonicalEmail, full_name AS fullName
       FROM people WHERE workspace_id = ? ORDER BY id`,
    )
    .all(workspaceId) as unknown as ExistingPersonIdentity[];
}

function rejectedPreviewRow(
  rowNumber: number,
  cells: string[],
  reason: string,
): CrmCsvPreviewRow {
  return {
    rowNumber,
    email: cells[0] ?? "",
    fullName: cells[1] ?? "",
    organization: cells[2] ? optionalCrmField(cells[2]) : null,
    title: cells[3] ? optionalCrmField(cells[3]) : null,
    normalizedEmail: cells[0] ? normalizeCrmEmail(cells[0]) : null,
    normalizedName: cells[1] ? normalizeCrmName(cells[1]) : null,
    disposition: "REJECTED",
    reason,
  };
}

function previewRows(
  db: Db,
  workspaceId: string,
  records: string[][],
): CrmCsvPreviewRow[] {
  const people = existingPeople(db, workspaceId);
  const byEmail = new Map<string, ExistingPersonIdentity[]>();
  for (const person of people) {
    const key = normalizeCrmEmail(person.canonicalEmail);
    const matches = byEmail.get(key) ?? [];
    matches.push(person);
    byEmail.set(key, matches);
  }
  const byName = new Map<string, ExistingPersonIdentity[]>();
  for (const person of people) {
    const key = normalizeCrmName(person.fullName);
    const matches = byName.get(key) ?? [];
    matches.push(person);
    byName.set(key, matches);
  }

  const seenEmails = new Set<string>();
  const seenNames = new Set<string>();
  const seenTargets = new Set<string>();
  return records.map((cells, index) => {
    const rowNumber = index + 2;
    if (cells.length !== CRM_CSV_HEADER.length) {
      return rejectedPreviewRow(rowNumber, cells, "EXPECTED_FOUR_COLUMNS");
    }
    const email = normalizeCrmEmail(cells[0] ?? "");
    const fullName = normaliseCell(cells[1] ?? "");
    const organization = optionalCrmField(cells[2] ?? "");
    const title = optionalCrmField(cells[3] ?? "");
    if (!isValidSyntheticEmail(email)) {
      return rejectedPreviewRow(rowNumber, cells, "SYNTHETIC_EMAIL_REQUIRED");
    }
    if (fullName.length < 1 || fullName.length > 120) {
      return rejectedPreviewRow(rowNumber, cells, "FULL_NAME_REQUIRED_OR_TOO_LONG");
    }
    if ([organization, title].some((value) => value !== null && value.length > CRM_CSV_MAX_FIELD_LENGTH)) {
      return rejectedPreviewRow(rowNumber, cells, "FIELD_TOO_LONG");
    }
    if (seenEmails.has(email)) {
      return rejectedPreviewRow(rowNumber, cells, "DUPLICATE_INPUT_EMAIL");
    }
    seenEmails.add(email);
    const nameKey = normalizeCrmName(fullName);
    if (seenNames.has(nameKey)) {
      return rejectedPreviewRow(rowNumber, cells, "DUPLICATE_INPUT_NAME");
    }
    seenNames.add(nameKey);

    const emailMatches = byEmail.get(email) ?? [];
    const nameMatches = byName.get(nameKey) ?? [];
    if (emailMatches.length > 1) {
      return rejectedPreviewRow(rowNumber, cells, "AMBIGUOUS_NORMALIZED_EMAIL");
    }
    const emailMatch = emailMatches[0];
    const nameMatch = nameMatches.length === 1 ? nameMatches[0] : undefined;
    if (!emailMatch && nameMatches.length > 1) {
      return rejectedPreviewRow(rowNumber, cells, "AMBIGUOUS_NORMALIZED_NAME");
    }
    const match = emailMatch ?? nameMatch;
    if (!match) {
      return {
        rowNumber,
        email,
        fullName,
        organization,
        title,
        normalizedEmail: email,
        normalizedName: nameKey,
        disposition: "CREATE",
      };
    }
    if (seenTargets.has(match.id)) {
      return rejectedPreviewRow(rowNumber, cells, "DUPLICATE_PERSON_CANDIDATE");
    }
    seenTargets.add(match.id);
    return {
      rowNumber,
      email,
      fullName,
      organization,
      title,
      normalizedEmail: email,
      normalizedName: nameKey,
      disposition: "MERGE_CANDIDATE",
      matchPersonId: match.id,
      matchPersonName: match.fullName,
      matchReason: emailMatch ? "EMAIL_EXACT" : "NAME_NORMALIZED_CANDIDATE",
    };
  });
}

function summarisePreview(
  inputFingerprint: string,
  rows: CrmCsvPreviewRow[],
): CrmCsvPreview {
  return {
    schema: CRM_CSV_SCHEMA,
    header: [...CRM_CSV_HEADER],
    inputFingerprint,
    rows,
    createCount: rows.filter((row) => row.disposition === "CREATE").length,
    mergeCandidateCount: rows.filter((row) => row.disposition === "MERGE_CANDIDATE").length,
    rejectedCount: rows.filter((row) => row.disposition === "REJECTED").length,
    requiresConfirmation: rows.some((row) => row.disposition !== "REJECTED"),
  };
}

/** Parse and preview only; this function never writes canonical records. */
export function previewCrmCsvImport(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
  csv: string,
): CrmCsvPreview {
  requireCrmOrganizerAccess(db, session, requestedWorkspaceSlug);
  const parsed = parseCrmCsv(csv);
  return summarisePreview(
    parsed.inputFingerprint,
    previewRows(db, session.workspaceId, parsed.records),
  );
}

function readReceipt(
  db: Db,
  workspaceId: string,
  receiptId: string,
  inputFingerprint: string,
): CrmCsvImportReceipt | null {
  const row = db
    .prepare(
      `SELECT workspace_id AS workspaceId, action, target_type AS targetType,
              target_id AS targetId, details_json AS detailsJson
       FROM audit_events WHERE id = ? AND workspace_id = ?`,
    )
    .get(receiptId, workspaceId) as {
    workspaceId: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    detailsJson: string | null;
  } | undefined;
  if (!row) {
    return null;
  }
  if (
    row.action !== "crm.csv.import" ||
    row.targetType !== "workspace" ||
    row.targetId !== workspaceId ||
    !row.detailsJson
  ) {
    throw new Error("CRM_IMPORT_RECEIPT_CONFLICT");
  }
  try {
    const parsed = JSON.parse(row.detailsJson) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schema !== CRM_CSV_SCHEMA ||
      parsed.receiptId !== receiptId ||
      parsed.inputFingerprint !== inputFingerprint ||
      parsed.canonicalWrites !== true ||
      !Array.isArray(parsed.rows)
    ) {
      throw new Error("invalid receipt");
    }
    return parsed as unknown as CrmCsvImportReceipt;
  } catch {
    throw new Error("CRM_IMPORT_RECEIPT_CONFLICT");
  }
}

/** Confirm a previously previewed import and append immutable evidence/link history. */
export function confirmCrmCsvImport(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
  csv: string,
  expectedFingerprint: string,
): CrmCsvImportReceipt {
  requireCrmOrganizerAccess(db, session, requestedWorkspaceSlug);
  const preview = previewCrmCsvImport(db, session, requestedWorkspaceSlug, csv);
  if (preview.inputFingerprint !== expectedFingerprint) {
    throw new Error("CRM_IMPORT_PREVIEW_STALE");
  }

  const receiptId = deterministicUuid(
    `audit:crm.csv.import:${session.workspaceId}:${preview.inputFingerprint}`,
  );
  return withTransaction(db, () => {
    const existingReceipt = readReceipt(
      db,
      session.workspaceId,
      receiptId,
      preview.inputFingerprint,
    );
    if (existingReceipt) {
      return existingReceipt;
    }

    const completedAt = nowIso();
    const receiptRows: CrmCsvReceiptRow[] = [];
    let createdCount = 0;
    let mergedCount = 0;
    let sourceRecordCount = 0;
    let sourceLinkCount = 0;
    const insertRecord = db.prepare(
      `INSERT INTO source_records
       (id, workspace_id, provider, source_ref, version, payload_json, imported_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    );
    const insertPerson = db.prepare(
      `INSERT INTO people
       (id, workspace_id, canonical_email, full_name, organization, title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLink = db.prepare(
      `INSERT INTO source_links
       (id, workspace_id, person_id, source_record_id, link_decision, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const row of preview.rows) {
      if (row.disposition === "REJECTED") {
        receiptRows.push({
          rowNumber: row.rowNumber,
          status: "REJECTED",
          email: row.email,
          fullName: row.fullName,
          reason: row.reason,
        });
        continue;
      }
      const sourceRef = `crm-csv/${preview.inputFingerprint}/row-${row.rowNumber}`;
      const sourceRecordId = deterministicUuid(
        `crm-source:${session.workspaceId}:${sourceRef}`,
      );
      const payloadJson = canonicalJson({
        schema: CRM_CSV_SCHEMA,
        provider: CRM_CSV_PROVIDER,
        sourceRef,
        version: 1,
        record: {
          email: row.email,
          fullName: row.fullName,
          organization: row.organization,
          title: row.title,
        },
        provenance: {
          importReceiptId: receiptId,
          inputFingerprint: preview.inputFingerprint,
          row: row.rowNumber,
          importedAt: completedAt,
        },
      });
      insertRecord.run(
        sourceRecordId,
        session.workspaceId,
        CRM_CSV_PROVIDER,
        sourceRef,
        payloadJson,
        completedAt,
      );
      sourceRecordCount += 1;

      let personId = row.matchPersonId;
      if (!personId) {
        personId = deterministicUuid(
          `crm-person:${session.workspaceId}:${row.normalizedEmail}`,
        );
        insertPerson.run(
          personId,
          session.workspaceId,
          row.email,
          row.fullName,
          row.organization,
          row.title,
          completedAt,
        );
        createdCount += 1;
      } else {
        const existing = db
          .prepare("SELECT id FROM people WHERE id = ? AND workspace_id = ?")
          .get(personId, session.workspaceId) as { id: string } | undefined;
        if (!existing) {
          throw new Error("CRM_IMPORT_PREVIEW_STALE");
        }
        mergedCount += 1;
      }

      insertLink.run(
        deterministicUuid(`crm-link:${session.workspaceId}:${sourceRef}`),
        session.workspaceId,
        personId,
        sourceRecordId,
        row.disposition === "CREATE"
          ? "crm-csv:create"
          : row.matchReason === "EMAIL_EXACT"
            ? "crm-csv:merge-email"
            : "crm-csv:merge-normalized-name",
        completedAt,
      );
      sourceLinkCount += 1;
      receiptRows.push({
        rowNumber: row.rowNumber,
        status: row.disposition === "CREATE" ? "CREATED" : "MERGED",
        email: row.email,
        fullName: row.fullName,
        personId,
        reason: row.matchReason,
      });
    }

    const receipt: CrmCsvImportReceipt = {
      schema: CRM_CSV_SCHEMA,
      receiptId,
      inputFingerprint: preview.inputFingerprint,
      completedAt,
      createdCount,
      mergedCount,
      rejectedCount: receiptRows.filter((row) => row.status === "REJECTED").length,
      canonicalWrites: true,
      provenance: {
        provider: CRM_CSV_PROVIDER,
        sourceRecordCount,
        sourceLinkCount,
      },
      rows: receiptRows,
    };
    db.prepare(
      `INSERT INTO audit_events
       (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
       VALUES (?, ?, 'account', ?, 'crm.csv.import', 'workspace', ?, ?, ?)`,
    ).run(
      receiptId,
      session.workspaceId,
      session.accountId,
      session.workspaceId,
      canonicalJson(receipt),
      completedAt,
    );
    return receipt;
  });
}

/**
 * Organizer authorization is repeated at the module query boundary so a future caller cannot
 * accidentally turn the CRM service into an unguarded People read. Workspace identity is
 * derived from the session and checked against the route slug before the database query runs.
 */
export function requireCrmOrganizerAccess(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
): void {
  assertWorkspaceMatch(session, requestedWorkspaceSlug);
  requireCapability(db, session, "phase0.pipeline.manage");
}

/** Read the canonical People projection for the authorized workspace. */
export function getCrmWorkspaceView(
  db: Db,
  session: SessionInfo,
  requestedWorkspaceSlug: string,
): CrmWorkspaceView | null {
  requireCrmOrganizerAccess(db, session, requestedWorkspaceSlug);

  const workspace = db
    .prepare(
      `SELECT id, slug, name
       FROM workspaces
       WHERE id = ? AND slug = ?`,
    )
    .get(session.workspaceId, requestedWorkspaceSlug) as WorkspaceRow | undefined;
  if (!workspace) {
    return null;
  }

  const people = db
    .prepare(
      `SELECT p.id,
              p.canonical_email AS canonicalEmail,
              p.full_name AS fullName,
              p.organization,
              p.title,
              (SELECT COUNT(*)
               FROM source_links l
               WHERE l.person_id = p.id
                 AND l.workspace_id = p.workspace_id) AS sourceCount
       FROM people p
       WHERE p.workspace_id = ?
       ORDER BY p.full_name COLLATE NOCASE, p.id`,
    )
    .all(session.workspaceId) as unknown as PersonRow[];

  const organizationNames = new Set(
    people
      .map((person) => person.organization?.trim())
      .filter((organization): organization is string => Boolean(organization)),
  );

  return {
    workspace: {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
    },
    people: people.map((person) => ({
      id: person.id,
      canonicalEmail: person.canonicalEmail,
      fullName: person.fullName,
      organization: person.organization,
      title: person.title,
      sourceCount: person.sourceCount,
    })),
    metrics: {
      totalPeople: people.length,
      organizations: organizationNames.size,
      withOrganization: people.filter((person) => Boolean(person.organization?.trim())).length,
      withTitle: people.filter((person) => Boolean(person.title?.trim())).length,
      sourcedPeople: people.filter((person) => person.sourceCount > 0).length,
    },
  };
}
