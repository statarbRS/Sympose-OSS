import type { Db } from "../../db";
import { withTransactionOrSavepoint } from "../../db";
import { canonicalJson, deterministicUuid, fingerprintOf, nowIso } from "../../canonical";
import { getEvent } from "../events";
import { publicReleaseReference } from "../public-reference";
import {
  isEmbedConfigurationId,
  parseEmbedConfigurationValue,
  type EmbedConfiguration,
  type SavedEmbedConfiguration,
} from "./embed";

export const PUBLIC_EMBED_CONFIGURATION_SCHEMA = "publication-embed-configuration/v1" as const;
export const PUBLIC_EMBED_CONFIGURATION_EVENT_TYPE = "publication.embed_configuration.saved" as const;
export const PUBLIC_EMBED_CONFIGURATION_AGGREGATE_TYPE = "publication_embed_configuration" as const;
export const MAX_PUBLIC_EMBED_CONFIGURATIONS = 12;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CHANNEL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export interface EmbedConfigurationScope {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly channelReference: string;
}

export interface SaveEmbedConfigurationInput {
  readonly scope: EmbedConfigurationScope;
  readonly label: string;
  readonly configuration: EmbedConfiguration;
  readonly idempotencyKey: string;
  /** Optional only for imported/replayed callers; ordinary saves derive this ID server-side. */
  readonly configurationId?: string;
  readonly actorAccountId?: string;
}

export interface PersistedEmbedConfiguration extends SavedEmbedConfiguration {
  readonly schema: typeof PUBLIC_EMBED_CONFIGURATION_SCHEMA;
  readonly scope: EmbedConfigurationScope;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface EmbedConfigurationWriteResult {
  readonly configuration: PersistedEmbedConfiguration;
  readonly created: boolean;
}

export class EmbedConfigurationError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "EMBED_CONFIG_SCOPE_DENIED"
    | "IDEMPOTENCY_KEY_CONFLICT"
    | "EMBED_CONFIG_LIMIT_REACHED"
    | "EMBED_CONFIG_STATE_INVALID"
    | "EMBED_CONFIG_NOT_FOUND"
    | "PERSISTENCE_FAILED";

  constructor(
    code: EmbedConfigurationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "EmbedConfigurationError";
    this.code = code;
  }
}

export class EmbedConfigurationInputError extends EmbedConfigurationError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
    this.name = "EmbedConfigurationInputError";
  }
}

export class EmbedConfigurationAuthorizationError extends EmbedConfigurationError {
  constructor(message = "The embed configuration is not in the requested workspace/event scope.") {
    super("EMBED_CONFIG_SCOPE_DENIED", message);
    this.name = "EmbedConfigurationAuthorizationError";
  }
}

export class EmbedConfigurationConflictError extends EmbedConfigurationError {
  constructor(message = "The embed configuration idempotency key conflicts with an existing save.") {
    super("IDEMPOTENCY_KEY_CONFLICT", message);
    this.name = "EmbedConfigurationConflictError";
  }
}

interface StoredEmbedConfigurationRow {
  readonly id: string;
  readonly configurationId: string;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly channelReference: string;
  readonly payloadJson: string;
  readonly payloadFingerprint: string;
  readonly createdAt: string;
}

interface PublicEmbedConfigurationRow extends StoredEmbedConfigurationRow {
  readonly sealedReleaseId: string;
  readonly sealedEventName: string | null;
}

function safeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value) || CONTROL_CHARACTER.test(value)) {
    throw new EmbedConfigurationInputError(`${field} is invalid.`);
  }
  return value;
}

function channelReference(value: unknown): string {
  if (typeof value !== "string" || !CHANNEL_REFERENCE.test(value) || CONTROL_CHARACTER.test(value)) {
    throw new EmbedConfigurationInputError("channelReference is invalid.");
  }
  return value;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new EmbedConfigurationInputError(`${field} is invalid.`);
  }
  return value.trim();
}

function normalizeInput(input: SaveEmbedConfigurationInput): {
  readonly scope: EmbedConfigurationScope;
  readonly label: string;
  readonly configuration: EmbedConfiguration;
  readonly idempotencyKey: string;
  readonly configurationId: string;
  readonly requestFingerprint: string;
} {
  if (input === null || typeof input !== "object") {
    throw new EmbedConfigurationInputError("The embed configuration command is invalid.");
  }
  const scope = {
    workspaceId: safeIdentifier(input.scope?.workspaceId, "workspaceId"),
    eventId: safeIdentifier(input.scope?.eventId, "eventId"),
    channelReference: channelReference(input.scope?.channelReference),
  } as const;
  const label = boundedText(input.label, "label", 240);
  const configuration = parseEmbedConfigurationValue(input.configuration);
  if (!configuration) {
    throw new EmbedConfigurationInputError("configuration contains an unsupported value.");
  }
  const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 240);
  const configurationId = input.configurationId === undefined
    ? deterministicUuid(
        `publication-embed-configuration:${scope.workspaceId}:${scope.eventId}:${scope.channelReference}:${idempotencyKey}`,
      )
    : safeIdentifier(input.configurationId, "configurationId");
  if (!isEmbedConfigurationId(configurationId)) {
    throw new EmbedConfigurationInputError("configurationId is invalid.");
  }
  const requestFingerprint = fingerprintOf({
    schema: PUBLIC_EMBED_CONFIGURATION_SCHEMA,
    scope,
    label,
    configuration,
    idempotencyKey,
    configurationId,
  });
  return { scope, label, configuration, idempotencyKey, configurationId, requestFingerprint };
}

function requestBasis(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: payload.schema,
    scope: payload.scope,
    label: payload.label,
    configuration: payload.configuration,
    idempotencyKey: payload.idempotencyKey,
    configurationId: payload.configurationId,
  };
}

function parseStoredPayload(
  row: StoredEmbedConfigurationRow,
): PersistedEmbedConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson) as unknown;
  } catch {
    throw new EmbedConfigurationError(
      "EMBED_CONFIG_STATE_INVALID",
      "Stored embed configuration evidence is invalid.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EmbedConfigurationError(
      "EMBED_CONFIG_STATE_INVALID",
      "Stored embed configuration evidence is invalid.",
    );
  }
  const payload = parsed as Record<string, unknown>;
  const scopeValue = payload.scope;
  if (scopeValue === null || typeof scopeValue !== "object" || Array.isArray(scopeValue)) {
    throw new EmbedConfigurationError(
      "EMBED_CONFIG_STATE_INVALID",
      "Stored embed configuration scope is invalid.",
    );
  }
  const payloadScope = scopeValue as Record<string, unknown>;
  let scope: EmbedConfigurationScope;
  try {
    scope = {
      workspaceId: safeIdentifier(payloadScope.workspaceId, "workspaceId"),
      eventId: safeIdentifier(payloadScope.eventId, "eventId"),
      channelReference: channelReference(payloadScope.channelReference),
    };
  } catch {
    throw new EmbedConfigurationError(
      "EMBED_CONFIG_STATE_INVALID",
      "Stored embed configuration scope is invalid.",
    );
  }
  const configuration = parseEmbedConfigurationValue(payload.configuration);
  const id = payload.configurationId;
  const label = payload.label;
  const idempotencyKey = payload.idempotencyKey;
  const requestFingerprint = payload.requestFingerprint;
  const createdAt = payload.createdAt;
  if (
    payload.schema !== PUBLIC_EMBED_CONFIGURATION_SCHEMA ||
    typeof id !== "string" ||
    !isEmbedConfigurationId(id) ||
    typeof label !== "string" ||
    label.trim().length === 0 ||
    label.trim() !== label ||
    label.length > 240 ||
    CONTROL_CHARACTER.test(label) ||
    !configuration ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length === 0 ||
    idempotencyKey.trim() !== idempotencyKey ||
    idempotencyKey.length > 240 ||
    CONTROL_CHARACTER.test(idempotencyKey) ||
    typeof requestFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(requestFingerprint) ||
    typeof createdAt !== "string" ||
    Number.isNaN(Date.parse(createdAt)) ||
    row.createdAt !== createdAt ||
    row.configurationId !== id ||
    row.workspaceId !== scope.workspaceId ||
    row.eventId !== scope.eventId ||
    row.channelReference !== scope.channelReference ||
    canonicalJson(payload) !== row.payloadJson ||
    fingerprintOf(payload) !== row.payloadFingerprint ||
    fingerprintOf(requestBasis(payload)) !== requestFingerprint
  ) {
    throw new EmbedConfigurationError(
      "EMBED_CONFIG_STATE_INVALID",
      "Stored embed configuration evidence is invalid.",
    );
  }
  return Object.freeze({
    schema: PUBLIC_EMBED_CONFIGURATION_SCHEMA,
    id,
    label,
    configuration,
    savedAt: createdAt,
    scope,
    idempotencyKey,
    requestFingerprint,
  });
}

function eventExistsInScope(db: Db, scope: EmbedConfigurationScope): boolean {
  return getEvent(db, scope.workspaceId, scope.eventId) !== null;
}

function storedRowsForScope(db: Db, scope: EmbedConfigurationScope): StoredEmbedConfigurationRow[] {
  return db
    .prepare(
      `SELECT d.id,
              json_extract(d.payload_json, '$.configurationId') AS configurationId,
              d.workspace_id AS workspaceId,
              json_extract(d.payload_json, '$.scope.eventId') AS eventId,
              json_extract(d.payload_json, '$.scope.channelReference') AS channelReference,
              d.payload_json AS payloadJson,
              d.payload_fingerprint AS payloadFingerprint,
              d.created_at AS createdAt
       FROM domain_events d
       JOIN events e
         ON e.id = json_extract(d.payload_json, '$.scope.eventId')
        AND e.workspace_id = d.workspace_id
       WHERE d.workspace_id = ?
         AND d.event_type = ?
         AND d.aggregate_type = ?
         AND json_extract(d.payload_json, '$.scope.workspaceId') = ?
         AND json_extract(d.payload_json, '$.scope.eventId') = ?
         AND json_extract(d.payload_json, '$.scope.channelReference') = ?
       ORDER BY d.created_at ASC, d.rowid ASC
       LIMIT ?`,
    )
    .all(
      scope.workspaceId,
      PUBLIC_EMBED_CONFIGURATION_EVENT_TYPE,
      PUBLIC_EMBED_CONFIGURATION_AGGREGATE_TYPE,
      scope.workspaceId,
      scope.eventId,
      scope.channelReference,
      MAX_PUBLIC_EMBED_CONFIGURATIONS + 1,
    ) as unknown as StoredEmbedConfigurationRow[];
}

function findByIdempotencyKey(
  db: Db,
  input: ReturnType<typeof normalizeInput>,
): StoredEmbedConfigurationRow[] {
  return db
    .prepare(
      `SELECT d.id,
              json_extract(d.payload_json, '$.configurationId') AS configurationId,
              d.workspace_id AS workspaceId,
              json_extract(d.payload_json, '$.scope.eventId') AS eventId,
              json_extract(d.payload_json, '$.scope.channelReference') AS channelReference,
              d.payload_json AS payloadJson,
              d.payload_fingerprint AS payloadFingerprint,
              d.created_at AS createdAt
       FROM domain_events d
       WHERE d.workspace_id = ?
         AND d.event_type = ?
         AND d.aggregate_type = ?
         AND json_extract(d.payload_json, '$.scope.workspaceId') = ?
         AND json_extract(d.payload_json, '$.scope.eventId') = ?
         AND json_extract(d.payload_json, '$.scope.channelReference') = ?
         AND json_extract(d.payload_json, '$.idempotencyKey') = ?
       ORDER BY d.created_at ASC, d.rowid ASC`,
    )
    .all(
      input.scope.workspaceId,
      PUBLIC_EMBED_CONFIGURATION_EVENT_TYPE,
      PUBLIC_EMBED_CONFIGURATION_AGGREGATE_TYPE,
      input.scope.workspaceId,
      input.scope.eventId,
      input.scope.channelReference,
      input.idempotencyKey,
    ) as unknown as StoredEmbedConfigurationRow[];
}

function findByConfigurationId(
  db: Db,
  input: ReturnType<typeof normalizeInput>,
): StoredEmbedConfigurationRow[] {
  return db
    .prepare(
      `SELECT d.id,
              json_extract(d.payload_json, '$.configurationId') AS configurationId,
              d.workspace_id AS workspaceId,
              json_extract(d.payload_json, '$.scope.eventId') AS eventId,
              json_extract(d.payload_json, '$.scope.channelReference') AS channelReference,
              d.payload_json AS payloadJson,
              d.payload_fingerprint AS payloadFingerprint,
              d.created_at AS createdAt
       FROM domain_events d
       WHERE d.workspace_id = ?
         AND d.event_type = ?
         AND d.aggregate_type = ?
         AND json_extract(d.payload_json, '$.scope.workspaceId') = ?
         AND json_extract(d.payload_json, '$.scope.eventId') = ?
         AND json_extract(d.payload_json, '$.scope.channelReference') = ?
         AND json_extract(d.payload_json, '$.configurationId') = ?
       ORDER BY d.created_at ASC, d.rowid ASC
       LIMIT 2`,
    )
    .all(
      input.scope.workspaceId,
      PUBLIC_EMBED_CONFIGURATION_EVENT_TYPE,
      PUBLIC_EMBED_CONFIGURATION_AGGREGATE_TYPE,
      input.scope.workspaceId,
      input.scope.eventId,
      input.scope.channelReference,
      input.configurationId,
    ) as unknown as StoredEmbedConfigurationRow[];
}

function storedPayload(
  input: ReturnType<typeof normalizeInput>,
  createdAt: string,
): Record<string, unknown> {
  return {
    schema: PUBLIC_EMBED_CONFIGURATION_SCHEMA,
    scope: input.scope,
    configurationId: input.configurationId,
    label: input.label,
    configuration: input.configuration,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    createdAt,
  };
}

export function saveEmbedConfiguration(
  db: Db,
  input: SaveEmbedConfigurationInput,
): EmbedConfigurationWriteResult {
  const normalized = normalizeInput(input);
  if (!eventExistsInScope(db, normalized.scope)) {
    throw new EmbedConfigurationAuthorizationError();
  }
  return withTransactionOrSavepoint(db, "publication_embed_configuration", () => {
    const existing = findByIdempotencyKey(db, normalized);
    if (existing.length > 1) {
      throw new EmbedConfigurationError(
        "EMBED_CONFIG_STATE_INVALID",
        "Multiple embed configurations use the same idempotency key.",
      );
    }
    if (existing.length === 1) {
      const prior = parseStoredPayload(existing[0]!);
      if (prior.requestFingerprint !== normalized.requestFingerprint) {
        throw new EmbedConfigurationConflictError();
      }
      return { configuration: prior, created: false };
    }

    const existingId = findByConfigurationId(db, normalized);
    if (existingId.length > 1) {
      throw new EmbedConfigurationError(
        "EMBED_CONFIG_STATE_INVALID",
        "Multiple embed configuration events use the same configuration ID.",
      );
    }
    if (existingId.length === 1) {
      const prior = parseStoredPayload(existingId[0]!);
      if (prior.requestFingerprint === normalized.requestFingerprint) {
        return { configuration: prior, created: false };
      }
      throw new EmbedConfigurationConflictError(
        "The embed configuration ID is already used for different values.",
      );
    }

    const stored = storedRowsForScope(db, normalized.scope);
    if (stored.length > MAX_PUBLIC_EMBED_CONFIGURATIONS) {
      throw new EmbedConfigurationError(
        "EMBED_CONFIG_STATE_INVALID",
        "The event has too many persisted embed configurations.",
      );
    }
    if (stored.length === MAX_PUBLIC_EMBED_CONFIGURATIONS) {
      throw new EmbedConfigurationError(
        "EMBED_CONFIG_LIMIT_REACHED",
        "The event has reached its persisted embed configuration limit.",
      );
    }

    const createdAt = nowIso();
    const payload = storedPayload(normalized, createdAt);
    const payloadJson = canonicalJson(payload);
    const payloadFingerprint = fingerprintOf(payload);
    const domainEventId = deterministicUuid(
      `publication-embed-event:${normalized.scope.workspaceId}:${normalized.scope.eventId}:${normalized.scope.channelReference}:${normalized.configurationId}`,
    );
    db.prepare(
      `INSERT INTO domain_events
         (id, workspace_id, event_type, aggregate_type, aggregate_id,
          payload_json, payload_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      domainEventId,
      normalized.scope.workspaceId,
      PUBLIC_EMBED_CONFIGURATION_EVENT_TYPE,
      PUBLIC_EMBED_CONFIGURATION_AGGREGATE_TYPE,
      `publication-embed-configuration:${normalized.scope.eventId}:${normalized.configurationId}`,
      payloadJson,
      payloadFingerprint,
      createdAt,
    );
    const row: StoredEmbedConfigurationRow = {
      id: domainEventId,
      configurationId: normalized.configurationId,
      workspaceId: normalized.scope.workspaceId,
      eventId: normalized.scope.eventId,
      channelReference: normalized.scope.channelReference,
      payloadJson,
      payloadFingerprint,
      createdAt,
    };
    return {
      configuration: parseStoredPayload(row),
      created: true,
    };
  });
}

export function listEmbedConfigurations(
  db: Db,
  scope: EmbedConfigurationScope,
): readonly PersistedEmbedConfiguration[] {
  const normalizedScope: EmbedConfigurationScope = {
    workspaceId: safeIdentifier(scope.workspaceId, "workspaceId"),
    eventId: safeIdentifier(scope.eventId, "eventId"),
    channelReference: channelReference(scope.channelReference),
  };
  if (!eventExistsInScope(db, normalizedScope)) {
    throw new EmbedConfigurationAuthorizationError();
  }
  const rows = storedRowsForScope(db, normalizedScope);
  if (rows.length > MAX_PUBLIC_EMBED_CONFIGURATIONS) {
    throw new EmbedConfigurationError(
      "EMBED_CONFIG_STATE_INVALID",
      "The event has too many persisted embed configurations.",
    );
  }
  const configurations = rows.map(parseStoredPayload);
  if (new Set(configurations.map((configuration) => configuration.id)).size !== configurations.length) {
    throw new EmbedConfigurationError(
      "EMBED_CONFIG_STATE_INVALID",
      "Multiple embed configuration events use the same configuration ID.",
    );
  }
  return Object.freeze(configurations);
}

export function getEmbedConfiguration(
  db: Db,
  scope: EmbedConfigurationScope,
  configurationId: string,
): PersistedEmbedConfiguration | null {
  const normalizedScope: EmbedConfigurationScope = {
    workspaceId: safeIdentifier(scope.workspaceId, "workspaceId"),
    eventId: safeIdentifier(scope.eventId, "eventId"),
    channelReference: channelReference(scope.channelReference),
  };
  if (!isEmbedConfigurationId(configurationId)) return null;
  if (!eventExistsInScope(db, normalizedScope)) {
    throw new EmbedConfigurationAuthorizationError();
  }
  const rows = db
    .prepare(
      `SELECT d.id,
              json_extract(d.payload_json, '$.configurationId') AS configurationId,
              d.workspace_id AS workspaceId,
              json_extract(d.payload_json, '$.scope.eventId') AS eventId,
              json_extract(d.payload_json, '$.scope.channelReference') AS channelReference,
              d.payload_json AS payloadJson,
              d.payload_fingerprint AS payloadFingerprint,
              d.created_at AS createdAt
       FROM domain_events d
       WHERE d.workspace_id = ?
         AND d.event_type = ?
         AND d.aggregate_type = ?
         AND json_extract(d.payload_json, '$.scope.workspaceId') = ?
         AND json_extract(d.payload_json, '$.scope.eventId') = ?
         AND json_extract(d.payload_json, '$.scope.channelReference') = ?
         AND json_extract(d.payload_json, '$.configurationId') = ?
       ORDER BY d.created_at ASC, d.rowid ASC
       LIMIT 2`,
    )
    .all(
      normalizedScope.workspaceId,
      PUBLIC_EMBED_CONFIGURATION_EVENT_TYPE,
      PUBLIC_EMBED_CONFIGURATION_AGGREGATE_TYPE,
      normalizedScope.workspaceId,
      normalizedScope.eventId,
      normalizedScope.channelReference,
      configurationId,
    ) as unknown as StoredEmbedConfigurationRow[];
  if (rows.length > 1) {
    throw new EmbedConfigurationError(
      "EMBED_CONFIG_STATE_INVALID",
      "Multiple embed configuration events use the same configuration ID.",
    );
  }
  return rows[0] ? parseStoredPayload(rows[0]) : null;
}

function sealedEventName(raw: string | null): string | null {
  if (typeof raw !== "string" || raw.length > 4 * 1024 * 1024) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).event === null ||
      typeof (parsed as Record<string, unknown>).event !== "object"
    ) return null;
    const event = (parsed as Record<string, unknown>).event as Record<string, unknown>;
    return typeof event.name === "string" &&
      event.name.trim().length > 0 &&
      event.name.length <= 240 &&
      !CONTROL_CHARACTER.test(event.name)
      ? event.name
      : null;
  } catch {
    return null;
  }
}

/**
 * Public reads are intentionally keyed by the opaque stable config ID and the exact release-bound
 * public channel. The current sealed release must reproduce that same opaque channel reference;
 * joining an old configuration to a newer current release would otherwise let the old URL project
 * new content. The sealed content supplies the event label; mutable event rows are not used to
 * build the public surface.
 */
export function getPublicEmbedConfiguration(
  db: Db,
  channel: string,
  configurationId: string,
): (PersistedEmbedConfiguration & { readonly sealedReleaseId: string; readonly sealedEventName: string | null }) | null {
  if (!CHANNEL_REFERENCE.test(channel) || !isEmbedConfigurationId(configurationId)) return null;
  const rows = db
    .prepare(
      `SELECT d.id,
              json_extract(d.payload_json, '$.configurationId') AS configurationId,
              d.workspace_id AS workspaceId,
              json_extract(d.payload_json, '$.scope.eventId') AS eventId,
              json_extract(d.payload_json, '$.scope.channelReference') AS channelReference,
              d.payload_json AS payloadJson,
              d.payload_fingerprint AS payloadFingerprint,
              d.created_at AS createdAt,
              r.id AS sealedReleaseId,
              r.content_json AS sealedContent
       FROM domain_events d
       JOIN events e
         ON e.id = json_extract(d.payload_json, '$.scope.eventId')
        AND e.workspace_id = d.workspace_id
       JOIN publication_releases r
         ON r.id = e.current_release_id
        AND r.workspace_id = e.workspace_id
        AND r.event_id = e.id
       WHERE d.event_type = ?
         AND d.aggregate_type = ?
         AND json_extract(d.payload_json, '$.scope.channelReference') = ?
         AND json_extract(d.payload_json, '$.configurationId') = ?
         AND e.current_release_id IS NOT NULL
         AND r.sealed_at IS NOT NULL
       ORDER BY d.created_at ASC, d.rowid ASC
       LIMIT 2`,
    )
    .all(
      PUBLIC_EMBED_CONFIGURATION_EVENT_TYPE,
      PUBLIC_EMBED_CONFIGURATION_AGGREGATE_TYPE,
      channel,
      configurationId,
    ) as unknown as Array<StoredEmbedConfigurationRow & { readonly sealedReleaseId: string; readonly sealedContent: string | null }>;
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const configuration = parseStoredPayload(row);
  let exactReleaseReference: string;
  try {
    exactReleaseReference = publicReleaseReference({
      workspaceId: configuration.scope.workspaceId,
      eventId: configuration.scope.eventId,
      releaseId: row.sealedReleaseId,
    });
  } catch {
    return null;
  }
  if (
    configuration.scope.channelReference !== channel ||
    exactReleaseReference !== channel
  ) return null;
  const eventName = sealedEventName(row.sealedContent);
  if (eventName === null) return null;
  return Object.freeze({
    ...configuration,
    sealedReleaseId: row.sealedReleaseId,
    sealedEventName: eventName,
  });
}
