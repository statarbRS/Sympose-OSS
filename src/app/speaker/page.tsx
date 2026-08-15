import type { Metadata } from "next";
import Link from "next/link";
import { cookies, headers } from "next/headers";

import { getSyntheticSpeakerOperationsRepository } from "@/server/services/speaker-operations";
import { getDb } from "@/server/db";
import { speakerPortalLookupBudgetKeyFromHeaders } from "@/server/services/speaker-portal-access";
import { SpeakerPortal } from "@/components/speaker-portal/speaker-portal";
import { SpeakerPortalEntry } from "@/components/speaker-portal/portal-entry";

import styles from "@/components/speaker-portal/speaker-portal.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Speaker portal · Sympose", description: "Scoped speaker event portal.", referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function SpeakerPortalPage() {
  const store = await cookies();
  const token = store.get("sympose_speaker_portal")?.value;
  if (!token) return <SpeakerPortalEntry />;
  const projection = getSyntheticSpeakerOperationsRepository(getDb()).getPortalProjection(
    token,
    speakerPortalLookupBudgetKeyFromHeaders(await headers(), "page"),
  );
  if (!projection) return <DeniedPortal />;
  return <SpeakerPortal projection={projection} supportPreview={store.get("sympose_speaker_support_preview")?.value === "synthetic-local"} />;
}

function DeniedPortal() {
  return <main className={styles.portalMain} id="main-content"><article className={styles.entryCard}><p className={styles.eyebrow}>Scoped speaker portal</p><h1>Portal access unavailable</h1><p className={styles.lede}>This portal link is expired, revoked, malformed, or outside the permitted event/person scope. No speaker or event details are disclosed.</p><Link className={styles.primaryButton} href="/speaker/entry">Return to portal entry</Link></article></main>;
}
