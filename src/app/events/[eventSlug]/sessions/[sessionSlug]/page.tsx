import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicSessionDetail } from "@/components/public-agenda/public-agenda";
import { toPublicAgendaViewModel } from "@/components/public-agenda/public-agenda-view-model";
import { getDb } from "@/server/db";
import { getDurablePublicSession, resolveCurrentDurablePublicAgenda } from "@/server/services/public-agenda";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Session" };

export default async function PublicSessionPage({ params }: { params: Promise<{ eventSlug: string; sessionSlug: string }> }) {
  const { eventSlug, sessionSlug } = await params;
  const projection = resolveCurrentDurablePublicAgenda(getDb(), eventSlug);
  if (!projection || !getDurablePublicSession(projection, sessionSlug)) {
    notFound();
  }
  return <main className="shell page"><PublicSessionDetail projection={toPublicAgendaViewModel(projection)} sessionSlug={sessionSlug} /></main>;
}
