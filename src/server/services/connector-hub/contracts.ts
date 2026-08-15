export const AIRTABLE_CSV_SCHEMA = "sympose-airtable-people-event-involvement/v1" as const;
export const CONNECTOR_HUB_RECEIPT_SCHEMA = "connector-hub-local-receipt/v1" as const;

/**
 * Stable v1 columns for an Airtable import. A row represents one canonical Person and one
 * current event-role involvement. A Person without involvement receives one row with blank
 * event columns. Renaming, removing, or reordering a column requires a new export schema.
 */
export const AIRTABLE_CSV_HEADERS = [
  "person_id",
  "full_name",
  "email",
  "organization",
  "title",
  "event_id",
  "event_name",
  "event_starts_at",
  "event_timezone",
  "event_role",
  "participation_status",
] as const;

export const AIRTABLE_CSV_MAX_ROWS = 5_000;
export const AIRTABLE_CSV_MAX_BYTES = 2 * 1024 * 1024;
export const AIRTABLE_CSV_MAX_CELL_BYTES = 16 * 1024;

export const CONNECTOR_PROVIDER_IDS = ["airtable", "hubspot", "salesforce"] as const;
export type ConnectorProviderId = typeof CONNECTOR_PROVIDER_IDS[number];

export interface AirtableConnectorConfig {
  readonly provider: "airtable";
  readonly baseId: string;
  readonly tableName: string;
}

export interface HubSpotConnectorConfig {
  readonly provider: "hubspot";
  readonly portalId?: string;
  readonly portalName?: string;
}

export interface SalesforceConnectorConfig {
  readonly provider: "salesforce";
  readonly instanceUrl: string;
  readonly apiVersion: string;
}

export type ConnectorProviderConfig =
  | AirtableConnectorConfig
  | HubSpotConnectorConfig
  | SalesforceConnectorConfig;

export type ConnectorConnectionStatus = "ACTIVE" | "REVOKED";

export interface ConnectorConnectionSummary {
  readonly id: string;
  readonly provider: ConnectorProviderId;
  readonly status: ConnectorConnectionStatus;
  readonly config: ConnectorProviderConfig;
  readonly maskedSecret: "••••••••" | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}

export interface AirtableCsvExportLimits {
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly maxCellBytes: number;
}

export const AIRTABLE_CSV_LIMITS: AirtableCsvExportLimits = Object.freeze({
  maxRows: AIRTABLE_CSV_MAX_ROWS,
  maxBytes: AIRTABLE_CSV_MAX_BYTES,
  maxCellBytes: AIRTABLE_CSV_MAX_CELL_BYTES,
});

export interface AirtableCsvRow {
  readonly personId: string;
  readonly fullName: string;
  readonly email: string;
  readonly organization: string | null;
  readonly title: string | null;
  readonly eventId: string | null;
  readonly eventName: string | null;
  readonly eventStartsAt: string | null;
  readonly eventTimezone: string | null;
  readonly eventRole: string | null;
  readonly participationStatus: string | null;
}

export type ConnectorHubExportFailureCode =
  | "CONNECTOR_EXPORT_ROW_LIMIT"
  | "CONNECTOR_EXPORT_BYTE_LIMIT"
  | "CONNECTOR_EXPORT_DATA_INVALID"
  | "CONNECTOR_EXPORT_OPERATION_INVALID"
  | "CONNECTOR_EXPORT_OPERATION_CONFLICT"
  | "CONNECTOR_WORKSPACE_NOT_FOUND";

export interface ConnectorActivityEvidence {
  readonly receiptId: string;
  readonly outcome: "SUCCEEDED" | "FAILED";
  readonly occurredAt: string;
  readonly providerMutation: false;
  readonly exportSchema: typeof AIRTABLE_CSV_SCHEMA;
  readonly rowCount: number | null;
  readonly byteCount: number | null;
  readonly contentSha256: string | null;
  readonly failureCode: ConnectorHubExportFailureCode | null;
}

export interface ConnectorCapability {
  readonly label: string;
  readonly state: "AVAILABLE" | "UNAVAILABLE" | "DISABLED";
  readonly detail: string;
}

export interface ConnectorFieldMapping {
  readonly source: string;
  readonly destination: string;
  readonly detail: string;
}

export interface ConnectorProviderCard {
  readonly id: ConnectorProviderId;
  readonly name: "HubSpot" | "Salesforce" | "Airtable";
  readonly connectionStatus: "NOT_CONFIGURED" | ConnectorConnectionStatus;
  readonly connectionDetail: string;
  readonly connection?: ConnectorConnectionSummary | null;
  readonly capabilities: readonly ConnectorCapability[];
  readonly fieldMappings: readonly ConnectorFieldMapping[];
  readonly mappingDetail: string;
  readonly setupRequirements: readonly string[];
  readonly activityLabel: "Provider run" | "Local CSV export";
  readonly lastRun: ConnectorActivityEvidence | null;
  readonly lastFailure: ConnectorActivityEvidence | null;
  readonly evidenceWarning: boolean;
}

export interface ConnectorHubView {
  readonly workspace: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  };
  readonly peopleCount: number;
  readonly eventInvolvementCount: number;
  readonly exportRowCount: number;
  readonly providers: readonly ConnectorProviderCard[];
}

export interface ConnectorExportReceipt extends ConnectorActivityEvidence {
  readonly outcome: "SUCCEEDED";
  readonly rowCount: number;
  readonly byteCount: number;
  readonly contentSha256: string;
  readonly failureCode: null;
}

export interface AirtableCsvExportResult {
  readonly schema: typeof AIRTABLE_CSV_SCHEMA;
  readonly fileName: string;
  readonly contentType: "text/csv; charset=utf-8";
  readonly body: string;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly receipt: ConnectorExportReceipt;
  readonly receiptReplayed: boolean;
}
