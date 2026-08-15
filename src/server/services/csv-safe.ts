const FORMULA_PREFIX = /^[\s\u0000-\u001f\u007f-\u009f\uFEFF]*[=+\-@]/u;

/**
 * Serialize one CSV cell without allowing spreadsheet formula interpretation.
 * Numeric values remain numeric CSV fields; string values are neutralized only
 * when their first significant character is a spreadsheet formula trigger.
 */
export function csvSafeCell(value: unknown): string {
  const stringValue = value === null || value === undefined ? "" : String(value);
  const safeValue = typeof value === "string" && FORMULA_PREFIX.test(stringValue)
    ? `'${stringValue}`
    : stringValue;

  return /[",\r\n]/u.test(safeValue)
    ? `"${safeValue.replaceAll('"', '""')}"`
    : safeValue;
}
