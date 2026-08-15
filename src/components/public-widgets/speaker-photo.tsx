"use client";

import { useState } from "react";
import { initials } from "./public-widget-shell";
import styles from "./styles.module.css";

export function SpeakerPhoto({
  displayName,
  photoUrl,
}: {
  readonly displayName: string;
  readonly photoUrl: string | null;
}) {
  const [failed, setFailed] = useState(false);
  if (!photoUrl || failed) {
    return <span className={styles.photoFallback} aria-label={`${displayName} initials`}>{initials(displayName)}</span>;
  }
  return <img className={styles.photo} src={photoUrl} alt={`${displayName} photo`} onError={() => setFailed(true)} />;
}
