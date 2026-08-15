import { csvSafeCell } from "../csv-safe";

import {
  AIRTABLE_CSV_HEADERS,
  AIRTABLE_CSV_LIMITS,
  type AirtableCsvExportLimits,
  type AirtableCsvRow,
  type ConnectorActivityEvidence,
  type ConnectorHubExportFailureCode,
} from "./contracts";

const UNSUPPORTED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export class ConnectorHubExportError extends Error {
  readonly code: ConnectorHubExportFailureCode;
  readonly receipt: ConnectorActivityEvidence | null;

  constructor(
    code: ConnectorHubExportFailureCode,
    receipt: ConnectorActivityEvidence | null = null,
  ) {
    super(code);
    this.name = "ConnectorHubExportError";
    this.code = code;
    this.receipt = receipt;
  }
}

function assertLimits(limits: AirtableCsvExportLimits): void {
  if (
    !Number.isSafeInteger(limits.maxRows) ||
    limits.maxRows < 0 ||
    limits.maxRows > AIRTABLE_CSV_LIMITS.maxRows ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1 ||
    limits.maxBytes > AIRTABLE_CSV_LIMITS.maxBytes ||
    !Number.isSafeInteger(limits.maxCellBytes) ||
    limits.maxCellBytes < 1 ||
    limits.maxCellBytes > AIRTABLE_CSV_LIMITS.maxCellBytes
  ) {
    throw new ConnectorHubExportError("CONNECTOR_EXPORT_DATA_INVALID");
  }
}

function checkedCell(value: string | null, maximumBytes: number): string {
  const text = value ?? "";
  if (Buffer.byteLength(text, "utf8") > maximumBytes || UNSUPPORTED_CONTROL.test(text)) {
    throw new ConnectorHubExportError("CONNECTOR_EXPORT_DATA_INVALID");
  }
  return csvSafeCell(text);
}

function serializeRow(row: AirtableCsvRow, maximumCellBytes: number): string {
  const eventValues = [
    row.eventId,
    row.eventName,
    row.eventStartsAt,
    row.eventTimezone,
    row.eventRole,
    row.participationStatus,
  ];
  if (
    !row.personId ||
    !row.fullName ||
    !row.email ||
    (row.eventId === null && eventValues.some((value) => value !== null)) ||
    (row.eventId !== null && eventValues.some((value) => value === null))
  ) {
    throw new ConnectorHubExportError("CONNECTOR_EXPORT_DATA_INVALID");
  }

  return [
    row.personId,
    row.fullName,
    row.email,
    row.organization,
    row.title,
    row.eventId,
    row.eventName,
    row.eventStartsAt,
    row.eventTimezone,
    row.eventRole,
    row.participationStatus,
  ]
    .map((value) => checkedCell(value, maximumCellBytes))
    .join(",");
}

/** RFC4180 records use CRLF, including the final record terminator. */
export function serializeAirtableCsv(
  rows: readonly AirtableCsvRow[],
  limits: AirtableCsvExportLimits = AIRTABLE_CSV_LIMITS,
): { readonly body: string; readonly rowCount: number; readonly byteCount: number } {
  assertLimits(limits);
  if (rows.length > limits.maxRows) {
    throw new ConnectorHubExportError("CONNECTOR_EXPORT_ROW_LIMIT");
  }

  const records = [AIRTABLE_CSV_HEADERS.join(",")];
  let byteCount = Buffer.byteLength(`${records[0]}\r\n`, "utf8");
  if (byteCount > limits.maxBytes) {
    throw new ConnectorHubExportError("CONNECTOR_EXPORT_BYTE_LIMIT");
  }

  for (const row of rows) {
    const record = serializeRow(row, limits.maxCellBytes);
    const recordBytes = Buffer.byteLength(`${record}\r\n`, "utf8");
    if (byteCount + recordBytes > limits.maxBytes) {
      throw new ConnectorHubExportError("CONNECTOR_EXPORT_BYTE_LIMIT");
    }
    records.push(record);
    byteCount += recordBytes;
  }

  return {
    body: `${records.join("\r\n")}\r\n`,
    rowCount: rows.length,
    byteCount,
  };
}

export function airtableCsvFilename(workspaceSlug: string): string {
  const token = workspaceSlug
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/gu, "") || "workspace";
  return `sympose-${token}-people-events-airtable.csv`;
}
