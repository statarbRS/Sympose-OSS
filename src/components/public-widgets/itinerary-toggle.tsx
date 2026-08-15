"use client";

import { useEffect, useMemo, useState } from "react";

import {
  ITINERARY_UPDATED_EVENT,
  LocalStorageItineraryPersistence,
  toggleItineraryReference,
  itineraryStorageKey,
} from "@/server/services/public-widgets/itinerary";

import styles from "./styles.module.css";

const UPDATED_EVENT = ITINERARY_UPDATED_EVENT;

interface ItineraryUpdatedDetail {
  readonly storageKey: string;
  readonly references: readonly string[];
}

function isUpdatedDetail(value: unknown): value is ItineraryUpdatedDetail {
  if (value === null || typeof value !== "object") return false;
  const detail = value as { storageKey?: unknown; references?: unknown };
  return typeof detail.storageKey === "string" && Array.isArray(detail.references);
}

export function ItineraryToggleButton({
  releaseReference,
  sessionReference,
  compact = false,
}: {
  readonly releaseReference: string;
  readonly sessionReference: string;
  readonly compact?: boolean;
}) {
  const key = useMemo(
    () => ({ releaseReference } as const),
    [releaseReference],
  );
  const storageKey = useMemo(() => itineraryStorageKey(key), [key]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      const persistence = new LocalStorageItineraryPersistence(window.localStorage);
      setSaved(persistence.read(key).includes(sessionReference));
    } catch {
      setSaved(false);
    }

    function handleUpdated(event: Event): void {
      if (!(event instanceof CustomEvent) || !isUpdatedDetail(event.detail)) return;
      if (event.detail.storageKey === storageKey) {
        setSaved(event.detail.references.includes(sessionReference));
      }
    }

    window.addEventListener(UPDATED_EVENT, handleUpdated);
    return () => window.removeEventListener(UPDATED_EVENT, handleUpdated);
  }, [key, sessionReference, storageKey]);

  function toggle(): void {
    try {
      const persistence = new LocalStorageItineraryPersistence(window.localStorage);
      const references = toggleItineraryReference(persistence, key, sessionReference);
      setSaved(references.includes(sessionReference));
      window.dispatchEvent(new CustomEvent<ItineraryUpdatedDetail>(UPDATED_EVENT, {
        detail: { storageKey, references },
      }));
    } catch {
      // A browser storage failure must not turn a public read-only surface into an error page.
      setSaved(false);
    }
  }

  return (
    <button
      className={`${styles.favoriteButton} ${compact ? styles.favoriteButtonCompact : ""}`}
      type="button"
      aria-pressed={saved}
      aria-label={saved ? "Remove session from itinerary" : "Save session to itinerary"}
      data-session-reference={sessionReference}
      data-testid={`save-session-${sessionReference}`}
      onClick={toggle}
    >
      <span aria-hidden="true">{saved ? "★" : "☆"}</span>
      {saved ? "Saved" : "Save to itinerary"}
    </button>
  );
}
