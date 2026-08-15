import type { Metadata } from "next";

import { SpeakerPortalEntry } from "@/components/speaker-portal/portal-entry";

export const metadata: Metadata = { title: "Open speaker portal · Sympose", referrer: "no-referrer", robots: { index: false, follow: false } };

export default function SpeakerPortalEntryPage() {
  return <SpeakerPortalEntry />;
}
