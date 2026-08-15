import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { getDb } from "@/server/db";
import { resolveCurrentDurablePublicAgenda } from "@/server/services/public-agenda";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agenda" };

export default async function PublicEventPage({ params }: { params: Promise<{ eventSlug: string }> }) {
  const { eventSlug } = await params;
  const projection = resolveCurrentDurablePublicAgenda(getDb(), eventSlug);
  if (!projection) notFound();
  redirect(`/events/${encodeURIComponent(projection.event.slug)}/agenda`);
}
