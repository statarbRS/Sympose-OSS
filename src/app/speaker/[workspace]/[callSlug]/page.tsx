import Link from "next/link";
import { notFound } from "next/navigation";

import { loadApplicantPublicCall } from "@/app/cfp/actions";
import {
  EVALUATOR_CALL_SLUG,
  EVALUATOR_COMPATIBILITY_CALL_SLUG,
  EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
  EVALUATOR_WORKSPACE_SLUG,
} from "@/server/evaluator-demo";

export const dynamic = "force-dynamic";

export default async function SpeakerCheckpointPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; callSlug: string }>;
}) {
  const { workspace, callSlug } = await params;
  const isAcme = workspace === EVALUATOR_WORKSPACE_SLUG && callSlug === EVALUATOR_CALL_SLUG;
  const isDevflow = workspace === EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG && callSlug === EVALUATOR_COMPATIBILITY_CALL_SLUG;
  if (!isAcme && !isDevflow) notFound();
  const call = await loadApplicantPublicCall(workspace, callSlug);
  if (!call) notFound();

  return (
    <main className="speaker-demo">
      <article className="card speaker-demo__card" data-testid="speaker-checkpoint">
        <p className="speaker-demo__eyebrow">Scoped speaker entry</p>
        <h1>Speaker portal checkpoint</h1>
        <p className="speaker-demo__call">{call.name}</p>
        <div className="speaker-demo__grid">
          <section className="speaker-demo__section" aria-labelledby="accepted-session-title">
            <h2 id="accepted-session-title">Accepted session</h2>
            <p>
              {isDevflow
                ? "Priya Raman is the accepted speaker selected for the seeded DevFlow session. Open the portal entry to reach the canonical Person and current accepted assignment."
                : "The accepted speaker is available through the scoped portal entry. The portal resolves the canonical Person and current accepted assignment for this event."}
            </p>
          </section>
          <section className="speaker-demo__section" aria-labelledby="s0-boundary-title">
            <h2 id="s0-boundary-title">Current evidence boundary</h2>
            <p>
              The evaluator models scoped speaker tasks, profile and text submissions, immutable
              content versions and reviews, plus bounded PNG/PDF artifact uploads. Artifact tasks,
              general task changes, profile/text versions, and exact review evidence persist in
              local SQLite; artifact bytes persist in scoped local filesystem storage. The slice
              remains local and synthetic; no malware scanner, object-storage provider, SMTP, or
              provider delivery is configured.
            </p>
          </section>
        </div>
        <nav className="speaker-demo__actions" aria-label="Speaker checkpoint actions">
          <Link className="btn btn--primary" href={`/cfp/${workspace}/${callSlug}`}>
            Open public CFP
          </Link>
          <Link className="btn btn--primary" href="/speaker/entry">
            Open scoped speaker portal
          </Link>
          <Link className="btn btn--ghost" href="/">
            Return to evaluator entry
          </Link>
        </nav>
      </article>
    </main>
  );
}
