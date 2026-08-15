import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicAgenda } from "@/components/public-agenda/public-agenda";
import { toPublicAgendaViewModel } from "@/components/public-agenda/public-agenda-view-model";
import { getDb } from "@/server/db";
import { resolveCurrentDurablePublicAgenda } from "@/server/services/public-agenda";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agenda" };

export default async function PublicAgendaPage({ params }: { params: Promise<{ eventSlug: string }> }) {
  const { eventSlug } = await params;
  const projection = resolveCurrentDurablePublicAgenda(getDb(), eventSlug);
  if (!projection) {
    notFound();
  }
  return <main className="shell page"><PublicAgenda initialProjection={toPublicAgendaViewModel(projection)} /></main>;
}
