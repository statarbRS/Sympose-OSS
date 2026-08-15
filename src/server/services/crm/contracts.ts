/**
 * Pure CRM CSV contract values shared by the server service and client console.
 * Keep this module free of database, auth, and other server-only imports.
 */
export const CRM_CSV_SCHEMA = "crm-csv/v1" as const;
export const CRM_CSV_PROVIDER = "crm-csv.synthetic" as const;
export const CRM_CSV_HEADER = ["email", "full_name", "organization", "title"] as const;
export const CRM_CSV_MAX_BYTES = 64 * 1024;
export const CRM_CSV_MAX_ROWS = 100;
export const CRM_CSV_MAX_FIELD_LENGTH = 240;
