const AUDIENCE_REFERENCE_PATTERN = /^aud1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_FAVORITES = 500;

export const ITINERARY_UPDATED_EVENT = "sympose:itinerary-updated";

export interface ItineraryKey {
  /** Exact opaque reference for the sealed release that owns these browser-local choices. */
  readonly releaseReference: string;
}
export interface ItineraryPersistencePort {
  read(key: ItineraryKey): readonly string[];
  replace(key: ItineraryKey, sessionReferences: readonly string[]): readonly string[];
}

function validKey(key: ItineraryKey): boolean {
  return AUDIENCE_REFERENCE_PATTERN.test(key.releaseReference);
}

function mapKey(key: ItineraryKey): string {
  return key.releaseReference;
}

export function itineraryStorageKey(key: ItineraryKey): string {
  if (!validKey(key)) throw new Error("ITINERARY_KEY_INVALID");
  return `sympose:public-itinerary:${encodeURIComponent(mapKey(key))}`;
}

function normalizeReferences(sessionReferences: readonly string[]): readonly string[] {
  if (sessionReferences.length > MAX_FAVORITES) throw new Error("ITINERARY_TOO_LARGE");
  const unique = [...new Set(sessionReferences)];
  if (unique.some((reference) => !AUDIENCE_REFERENCE_PATTERN.test(reference))) {
    throw new Error("ITINERARY_REFERENCE_INVALID");
  }
  return Object.freeze(unique.sort());
}

export function parseStoredItinerary(raw: string | null): readonly string[] {
  if (!raw) return Object.freeze([]);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_FAVORITES || parsed.some((value) => typeof value !== "string")) {
      return Object.freeze([]);
    }
    return normalizeReferences(parsed as string[]);
  } catch {
    return Object.freeze([]);
  }
}

export interface BrowserStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Browser-local persistence for public references; it never stores release content or identity data. */
export class LocalStorageItineraryPersistence implements ItineraryPersistencePort {
  constructor(private readonly storage: BrowserStoragePort) {}

  read(key: ItineraryKey): readonly string[] {
    if (!validKey(key)) return Object.freeze([]);
    try {
      return parseStoredItinerary(this.storage.getItem(itineraryStorageKey(key)));
    } catch {
      return Object.freeze([]);
    }
  }

  replace(key: ItineraryKey, sessionReferences: readonly string[]): readonly string[] {
    const saved = normalizeReferences(sessionReferences);
    try {
      this.storage.setItem(itineraryStorageKey(key), JSON.stringify(saved));
    } catch {
      throw new Error("ITINERARY_STORAGE_UNAVAILABLE");
    }
    return saved;
  }
}

/** Deterministic test/browser fake; it intentionally has no storage or provider side effect. */
export class InMemoryItineraryPersistence implements ItineraryPersistencePort {
  private readonly values = new Map<string, readonly string[]>();

  read(key: ItineraryKey): readonly string[] {
    if (!validKey(key)) return Object.freeze([]);
    return this.values.get(mapKey(key)) ?? Object.freeze([]);
  }

  replace(key: ItineraryKey, sessionReferences: readonly string[]): readonly string[] {
    if (!validKey(key)) throw new Error("ITINERARY_KEY_INVALID");
    const saved = normalizeReferences(sessionReferences);
    this.values.set(mapKey(key), saved);
    return saved;
  }
}

export function toggleItineraryReference(
  persistence: ItineraryPersistencePort,
  key: ItineraryKey,
  sessionReference: string,
): readonly string[] {
  const current = new Set(persistence.read(key));
  if (current.has(sessionReference)) current.delete(sessionReference);
  else current.add(sessionReference);
  return persistence.replace(key, [...current].sort());
}
