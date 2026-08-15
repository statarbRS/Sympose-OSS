import {
  canonicalJson,
  cloneJsonValue,
  deepFreeze,
  fingerprint,
  hasOwn,
  isRecordObject,
} from "./canonical";
import {
  ChangeRadiusError,
  MATERIALITIES,
  type MaterialRecordingTerm,
  type MaterialTermChange,
  type MaterialTermComparison,
  type MaterialTermKind,
  type MaterialTermPolicy,
  type MaterialTerms,
  type Materiality,
} from "./types";

type PlainRecord = Record<string, unknown>;

const MATERIALITY_RANK: Record<Materiality, number> = {
  INFORMATIONAL: 0,
  REVIEW: 1,
  RECONFIRMATION: 2,
  UNKNOWN: 3,
  BLOCKING: 4,
};

const TIME_KEYS = new Set(["time", "startsAt", "endsAt", "startAt", "endAt"]);
const DURATION_KEYS = new Set(["duration", "durationMinutes"]);
const ROLE_KEYS = new Set(["role", "roleKey"]);
const VENUE_KEYS = new Set(["venue", "venueId", "roomId", "locationId", "room"]);
const RECORDING_KEYS = new Set(["recording", "recordingEnabled", "recordingRequired", "recordingMode"]);
const ALL_TERM_KEYS = new Set([...TIME_KEYS, ...DURATION_KEYS, ...ROLE_KEYS, ...VENUE_KEYS, ...RECORDING_KEYS]);

interface NormalizedTerms {
  readonly time?: unknown;
  readonly duration?: unknown;
  readonly role?: unknown;
  readonly venue?: unknown;
  readonly recording?: unknown;
  readonly unknown?: unknown;
}

interface Presence {
  readonly present: boolean;
  readonly value: unknown;
}

function canonicalOptional(value: unknown): string {
  return value === undefined ? "__undefined__" : canonicalJson(value);
}

/**
 * Keep absence distinct from JSON null without asking the canonical JSON
 * serializer to accept undefined. The wrapper is used only for fingerprints;
 * the public change retains the exact before/after values.
 */
function canonicalPresence(value: unknown): { readonly present: boolean; readonly value?: unknown } {
  return value === undefined
    ? { present: false }
    : { present: true, value: cloneJsonValue(value) };
}

export function canonicalMaterialTermChange(change: MaterialTermChange): Record<string, unknown> {
  return {
    kind: change.kind,
    changed: change.changed,
    before: canonicalPresence(change.before),
    after: canonicalPresence(change.after),
    materiality: change.materiality,
    reasonCode: change.reasonCode,
    reasonFingerprint: change.reasonFingerprint,
  };
}

export function materialityRank(value: Materiality): number {
  return MATERIALITY_RANK[value];
}

export function maxMateriality(left: Materiality, right: Materiality): Materiality {
  return materialityRank(left) >= materialityRank(right) ? left : right;
}

function validateMateriality(value: Materiality | undefined, fallback: Materiality): Materiality {
  if (value === undefined) return fallback;
  if (!(MATERIALITIES as readonly string[]).includes(value)) {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "Unknown materiality policy value.");
  }
  return value;
}

function policyFor(policy: MaterialTermPolicy | undefined, kind: MaterialTermKind, roomOnly: boolean): Materiality {
  const effective = policy ?? {};
  if (kind === "UNKNOWN") {
    if (effective.unknown !== undefined && effective.unknown !== "UNKNOWN") {
      throw new ChangeRadiusError("UNSAFE_UNKNOWN_POLICY", "Unknown terms may not be configured as safe.");
    }
    return "UNKNOWN";
  }

  if (kind === "TIME") return validateMateriality(effective.time, "RECONFIRMATION");
  if (kind === "DURATION") return validateMateriality(effective.duration, "RECONFIRMATION");
  if (kind === "ROLE") return validateMateriality(effective.role, "RECONFIRMATION");
  if (kind === "RECORDING") return validateMateriality(effective.recording, "RECONFIRMATION");

  const venuePolicy = effective.venue;
  if (typeof venuePolicy === "object" && venuePolicy !== null) {
    return validateMateriality(
      roomOnly ? venuePolicy.roomOnly : venuePolicy.crossVenue ?? venuePolicy.differentVenue ?? venuePolicy.other ?? venuePolicy.default,
      roomOnly ? "REVIEW" : "RECONFIRMATION",
    );
  }
  return validateMateriality(
    roomOnly ? effective.roomOnlyVenue ?? effective.venueRoomOnly ?? effective.roomOnly ?? effective.roomChange : venuePolicy,
    roomOnly ? "REVIEW" : "RECONFIRMATION",
  );
}

function objectValue(value: unknown): PlainRecord | undefined {
  return isRecordObject(value) ? value : undefined;
}

function firstPresent(record: PlainRecord, keys: readonly string[]): Presence {
  let found: Presence = { present: false, value: undefined };
  for (const key of keys) {
    if (!hasOwn(record, key)) continue;
    const current = { present: true, value: record[key] };
    if (found.present && canonicalOptional(found.value) !== canonicalOptional(current.value)) {
      throw new ChangeRadiusError("INVALID_MATERIAL_TERM", `Conflicting aliases for ${keys[0]}.`);
    }
    found = current;
  }
  return found;
}

function normalizeInstant(value: unknown, kind: string): string {
  if (typeof value !== "string") {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", `${kind} must be an ISO instant string.`);
  }
  // Local times and locale-formatted strings are deliberately not accepted.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", `${kind} must include an explicit timezone.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offset = match[8];
  const fraction = match[7];
  if (fraction !== undefined && fraction.length > 3) {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", `${kind} has unsupported sub-millisecond precision.`);
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", `${kind} is not a valid ISO instant.`);
  }
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", `${kind} has an invalid timezone offset.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", `${kind} is not a valid ISO instant.`);
  }
  return new Date(milliseconds).toISOString();
}

function normalizeTime(value: unknown, topLevel: PlainRecord | undefined): unknown {
  let source: unknown = value;
  if (source === undefined && topLevel !== undefined) {
    const start = firstPresent(topLevel, ["startsAt", "startAt"]);
    const end = firstPresent(topLevel, ["endsAt", "endAt"]);
    if (start.present || end.present) source = { start: start.value, end: end.value };
  }
  if (source === undefined) return undefined;
  if (typeof source === "string") return { start: normalizeInstant(source, "time") };
  const record = objectValue(source);
  if (!record) throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "time must be a string or object.");
  const start = firstPresent(record, ["start", "startsAt", "startAt"]);
  const end = firstPresent(record, ["end", "endsAt", "endAt"]);
  if (!start.present && !end.present) {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "time must contain a start or end instant.");
  }
  const result: PlainRecord = {};
  if (start.present) result.start = normalizeInstant(start.value, "time.start");
  if (end.present) result.end = normalizeInstant(end.value, "time.end");
  return result;
}

function normalizeDuration(value: unknown, topLevel: PlainRecord | undefined): unknown {
  let source: unknown = value;
  if (source === undefined && topLevel !== undefined) {
    const minutes = firstPresent(topLevel, ["durationMinutes"]);
    if (minutes.present) source = { minutes: minutes.value };
  }
  if (source === undefined) return undefined;
  let minutes: unknown = source;
  let seconds: unknown = undefined;
  if (isRecordObject(source)) {
    const minuteValue = firstPresent(source, ["minutes"]);
    const secondValue = firstPresent(source, ["seconds"]);
    minutes = minuteValue.present ? minuteValue.value : undefined;
    seconds = secondValue.present ? secondValue.value : undefined;
  }
  if (minutes === undefined && seconds === undefined) {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "duration must contain minutes or seconds.");
  }
  let totalSeconds = 0;
  if (minutes !== undefined) {
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
      throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "duration.minutes must be a non-negative number.");
    }
    totalSeconds += minutes * 60;
  }
  if (seconds !== undefined) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "duration.seconds must be a non-negative number.");
    }
    totalSeconds += seconds;
  }
  if (!Number.isFinite(totalSeconds)) {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "duration is too large.");
  }
  return { seconds: Object.is(totalSeconds, -0) ? 0 : totalSeconds };
}

function normalizeRole(value: unknown, topLevel: PlainRecord | undefined): unknown {
  let source: unknown = value;
  if (source === undefined && topLevel !== undefined) {
    const role = firstPresent(topLevel, ["roleKey"]);
    if (role.present) source = role.value;
  }
  if (source === undefined) return undefined;
  if (typeof source === "string") return { keys: [source] };
  if (Array.isArray(source)) {
    if (!source.every((entry) => typeof entry === "string")) {
      throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "role keys must be strings.");
    }
    return { keys: [...new Set(source)].sort() };
  }
  const record = objectValue(source);
  if (!record) throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "role must be a string, array, or object.");
  const key = firstPresent(record, ["key", "roleKey"]);
  const keys = firstPresent(record, ["keys"]);
  if (key.present && keys.present) {
    const normalizedKeys = normalizeRole(keys.value, undefined) as { readonly keys: readonly string[] };
    if (normalizedKeys.keys.length !== 1 || normalizedKeys.keys[0] !== key.value) {
      throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "role.key and role.keys conflict.");
    }
  }
  const selected = key.present ? [key.value] : keys.value;
  if (!Array.isArray(selected) || !selected.every((entry) => typeof entry === "string")) {
    throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "role must contain a key or keys.");
  }
  return { keys: [...new Set(selected)].sort() };
}

function normalizeVenue(value: unknown, topLevel: PlainRecord | undefined): unknown {
  let source: unknown = value;
  if (source === undefined && topLevel !== undefined) {
    const venue = firstPresent(topLevel, ["venueId"]);
    const room = firstPresent(topLevel, ["roomId", "room"]);
    const location = firstPresent(topLevel, ["locationId"]);
    if (venue.present || room.present || location.present) {
      source = { venueId: venue.value, roomId: room.value, locationId: location.value };
    }
  }
  if (source === undefined) return undefined;
  if (typeof source === "string") return { location: source };
  const record = objectValue(source);
  if (!record) throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "venue must be a string or object.");
  const result: PlainRecord = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean" && entry !== null) {
      // Structured location data is allowed only when it is canonical JSON.
      canonicalJson(entry);
    }
    result[key] = cloneJsonValue(entry);
  }
  return result;
}

function normalizeRecording(value: MaterialRecordingTerm | unknown, topLevel: PlainRecord | undefined): unknown {
  let source: unknown = value;
  if (source === undefined && topLevel !== undefined) {
    const enabled = firstPresent(topLevel, ["recordingEnabled"]);
    const required = firstPresent(topLevel, ["recordingRequired"]);
    const mode = firstPresent(topLevel, ["recordingMode"]);
    if (enabled.present || required.present || mode.present) {
      source = { enabled: enabled.value, required: required.value, mode: mode.value };
    }
  }
  if (source === undefined) return undefined;
  if (typeof source === "boolean") return { enabled: source };
  if (typeof source === "string") return { mode: source };
  const record = objectValue(source);
  if (!record) throw new ChangeRadiusError("INVALID_MATERIAL_TERM", "recording must be a boolean, string, or object.");
  const result: PlainRecord = {};
  const mode = firstPresent(record, ["mode", "recordingMode"]);
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    if (key === "mode" || key === "recordingMode") result.mode = mode.value;
    else {
      if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean" && entry !== null) {
        canonicalJson(entry);
      }
      result[key] = cloneJsonValue(entry);
    }
  }
  return result;
}

function normalizeTerms(input: unknown): NormalizedTerms {
  const topLevel = objectValue(input);
  if (!topLevel) {
    if (input === undefined) return {};
    canonicalJson(input);
    return { unknown: cloneJsonValue(input) };
  }

  const directTime = firstPresent(topLevel, ["time"]);
  const directDuration = firstPresent(topLevel, ["duration"]);
  const directRole = firstPresent(topLevel, ["role"]);
  const directVenue = firstPresent(topLevel, ["venue"]);
  const directRecording = firstPresent(topLevel, ["recording"]);

  const time = normalizeTime(directTime.value, topLevel);
  const duration = normalizeDuration(directDuration.value, topLevel);
  const role = normalizeRole(directRole.value, topLevel);
  const venue = normalizeVenue(directVenue.value, topLevel);
  const recording = normalizeRecording(directRecording.value, topLevel);

  const assertAliasAgreement = (direct: Presence, aliases: unknown, label: string): void => {
    if (!direct.present || aliases === undefined) return;
    const directNormalized = normalizedByKind(label, direct.value);
    const aliasNormalized = normalizedByKind(label, aliases);
    if (canonicalOptional(directNormalized) !== canonicalOptional(aliasNormalized)) {
      throw new ChangeRadiusError("INVALID_MATERIAL_TERM", `Conflicting aliases for ${label}.`);
    }
  };
  const timeAliases = aliasObject(topLevel, ["startsAt", "startAt", "endsAt", "endAt"]);
  const durationAliases = aliasObject(topLevel, ["durationMinutes"]);
  const roleAliases = aliasObject(topLevel, ["roleKey"]);
  const venueAliases = aliasObject(topLevel, ["venueId", "roomId", "locationId", "room"]);
  const recordingAliases = aliasObject(topLevel, ["recordingEnabled", "recordingRequired", "recordingMode"]);
  assertAliasAgreement(directTime, timeAliases, "time");
  assertAliasAgreement(directDuration, durationAliases, "duration");
  assertAliasAgreement(directRole, roleAliases, "role");
  assertAliasAgreement(directVenue, venueAliases, "venue");
  assertAliasAgreement(directRecording, recordingAliases, "recording");

  const unknown: PlainRecord = {};
  for (const key of Object.keys(topLevel).sort()) {
    if (ALL_TERM_KEYS.has(key)) continue;
    if (topLevel[key] === undefined) continue;
    canonicalJson(topLevel[key]);
    unknown[key] = cloneJsonValue(topLevel[key]);
  }

  return {
    ...(time === undefined ? {} : { time }),
    ...(duration === undefined ? {} : { duration }),
    ...(role === undefined ? {} : { role }),
    ...(venue === undefined ? {} : { venue }),
    ...(recording === undefined ? {} : { recording }),
    ...(Object.keys(unknown).length === 0 ? {} : { unknown }),
  };
}

function aliasObject(record: PlainRecord, keys: readonly string[]): PlainRecord | undefined {
  const aliases: PlainRecord = {};
  let present = false;
  for (const key of keys) {
    if (!hasOwn(record, key)) continue;
    present = true;
    aliases[key] = record[key];
  }
  return present ? aliases : undefined;
}

function normalizedByKind(kind: string, value: unknown): unknown {
  if (kind === "time") return normalizeTime(undefined, objectValue(value) ?? undefined) ?? normalizeTime(value, undefined);
  if (kind === "duration") return normalizeDuration(undefined, objectValue(value) ?? undefined) ?? normalizeDuration(value, undefined);
  if (kind === "role") return normalizeRole(undefined, objectValue(value) ?? undefined) ?? normalizeRole(value, undefined);
  if (kind === "venue") return normalizeVenue(undefined, objectValue(value) ?? undefined) ?? normalizeVenue(value, undefined);
  if (kind === "recording") return normalizeRecording(undefined, objectValue(value) ?? undefined) ?? normalizeRecording(value, undefined);
  return value;
}

function venueRoomOnly(before: unknown, after: unknown): boolean {
  if (!isRecordObject(before) || !isRecordObject(after)) return false;
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  const keys = [...new Set([...beforeKeys, ...afterKeys])];
  const roomKeys = new Set(["room", "roomId"]);
  const identityKeys = new Set(["venueId", "locationId", "location"]);
  let changedRoom = false;
  for (const key of keys) {
    const left = before[key];
    const right = after[key];
    if (canonicalOptional(left) === canonicalOptional(right)) continue;
    if (roomKeys.has(key)) changedRoom = true;
    else if (identityKeys.has(key)) return false;
    else return false;
  }
  const beforeIdentity = identityKeys.has("venueId") ? before.venueId : undefined;
  const afterIdentity = identityKeys.has("venueId") ? after.venueId : undefined;
  if (canonicalOptional(beforeIdentity) !== canonicalOptional(afterIdentity)) return false;
  return changedRoom;
}

function termFingerprint(kind: MaterialTermKind, before: unknown, after: unknown): string {
  return fingerprint({
    schemaVersion: 1,
    kind,
    before: canonicalPresence(before),
    after: canonicalPresence(after),
  });
}

function makeTermChange(
  kind: MaterialTermKind,
  before: unknown,
  after: unknown,
  materiality: Materiality,
  reasonCode: string,
): MaterialTermChange {
  const reasonFingerprint = termFingerprint(kind, before, after);
  return {
    kind,
    changed: true,
    before: cloneJsonValue(before),
    after: cloneJsonValue(after),
    materiality,
    reasonCode,
    reasonFingerprint,
  };
}

function maybeChange(
  kind: MaterialTermKind,
  before: unknown,
  after: unknown,
  policy: MaterialTermPolicy | undefined,
  roomOnly = false,
): MaterialTermChange | undefined {
  if (canonicalOptional(before) === canonicalOptional(after)) return undefined;
  const materiality = policyFor(policy, kind, roomOnly);
  const reasonCode = kind === "UNKNOWN" ? "UNKNOWN_MATERIAL_TERM_CHANGED" : `${kind}_TERM_CHANGED`;
  return makeTermChange(kind, before, after, materiality, reasonCode);
}

/** Compare only the exact, typed material-term vocabulary. Unknown differences stay UNKNOWN. */
export function compareMaterialTerms(
  before: MaterialTerms | unknown,
  after: MaterialTerms | unknown,
  policy?: MaterialTermPolicy,
): MaterialTermComparison {
  const left = normalizeTerms(before);
  const right = normalizeTerms(after);
  const changes: MaterialTermChange[] = [];

  const timeChange = maybeChange("TIME", left.time, right.time, policy);
  if (timeChange) changes.push(timeChange);
  const durationChange = maybeChange("DURATION", left.duration, right.duration, policy);
  if (durationChange) changes.push(durationChange);
  const roleChange = maybeChange("ROLE", left.role, right.role, policy);
  if (roleChange) changes.push(roleChange);
  const venueChange = maybeChange("VENUE", left.venue, right.venue, policy, venueRoomOnly(left.venue, right.venue));
  if (venueChange) changes.push(venueChange);
  const recordingChange = maybeChange("RECORDING", left.recording, right.recording, policy);
  if (recordingChange) changes.push(recordingChange);
  const unknownChange = maybeChange("UNKNOWN", left.unknown, right.unknown, policy);
  if (unknownChange) changes.push(unknownChange);

  let materiality: Materiality = "INFORMATIONAL";
  for (const change of changes) materiality = maxMateriality(materiality, change.materiality);
  const result: MaterialTermComparison = {
    equal: changes.length === 0,
    changed: changes.length > 0,
    materiality,
    changes,
    changedTerms: changes,
    fingerprint: fingerprint({
      schemaVersion: 1,
      before: left,
      after: right,
      changes: changes.map(canonicalMaterialTermChange),
    }),
  };
  return deepFreeze(result);
}

export function canonicalMaterialTerms(value: MaterialTerms | unknown): unknown {
  return normalizeTerms(value);
}

export const compareTerms = compareMaterialTerms;
export const materialTermComparator = compareMaterialTerms;
export { venueRoomOnly as isRoomOnlyVenueChange };
