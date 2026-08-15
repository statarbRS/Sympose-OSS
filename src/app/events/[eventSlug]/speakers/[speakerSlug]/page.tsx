import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicSpeakerDetail } from "@/components/public-agenda/public-agenda";
import { toPublicAgendaViewModel } from "@/components/public-agenda/public-agenda-view-model";
import { getDb } from "@/server/db";
import { getDurablePublicSpeaker, resolveCurrentDurablePublicAgenda } from "@/server/services/public-agenda";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Speaker" };

export default async function PublicSpeakerPage({ params }: { params: Promise<{ eventSlug: string; speakerSlug: string }> }) {
  const { eventSlug, speakerSlug } = await params;
  const projection = resolveCurrentDurablePublicAgenda(getDb(), eventSlug);
  if (!projection || !getDurablePublicSpeaker(projection, speakerSlug)) {
    notFound();
  }
  return <main className="shell page"><PublicSpeakerDetail projection={toPublicAgendaViewModel(projection)} speakerSlug={speakerSlug} /></main>;
}
