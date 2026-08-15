import { describe, expect, it } from "vitest";

import { csvSafeCell } from "@/server/services/csv-safe";

function parseCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < row.length; index += 1) {
    const character = row[index]!;
    if (inQuotes) {
      if (character === '"' && row[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (character === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }

  expect(inQuotes).toBe(false);
  cells.push(cell);
  return cells;
}

describe("spreadsheet-safe CSV cells", () => {
  it("neutralizes formula prefixes, including whitespace and control variants", () => {
    expect(["=SUM(A1)", "+1", "-1", "@cmd", "  =SUM(A1)", "\t=SUM(A1)", "\r=SUM(A1)", "\n=SUM(A1)"].map(csvSafeCell)).toEqual([
      "'=SUM(A1)",
      "'+1",
      "'-1",
      "'@cmd",
      "'  =SUM(A1)",
      "'\t=SUM(A1)",
      "\"'\r=SUM(A1)\"",
      "\"'\n=SUM(A1)\"",
    ]);
  });

  it("preserves ordinary text and numeric fields", () => {
    expect(csvSafeCell("Ada Lovelace")).toBe("Ada Lovelace");
    expect(csvSafeCell(42)).toBe("42");
    expect(csvSafeCell(-42)).toBe("-42");
    expect(csvSafeCell("42")).toBe("42");
  });

  it("quotes and escapes quote/newline content while preserving a CSV round trip", () => {
    const values = [
      "He said \"hello\"",
      "line one\nline two",
      "\r=SUM(A1)",
      "ordinary value",
    ];
    const serialized = values.map(csvSafeCell).join(",");

    expect(serialized).toBe("\"He said \"\"hello\"\"\",\"line one\nline two\",\"'\r=SUM(A1)\",ordinary value");
    expect(parseCsvRow(serialized)).toEqual([
      "He said \"hello\"",
      "line one\nline two",
      "'\r=SUM(A1)",
      "ordinary value",
    ]);
  });
});
