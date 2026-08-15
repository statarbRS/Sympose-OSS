import Link from "next/link";
import { notFound } from "next/navigation";

import { loadApplicantDraftPage } from "@/app/cfp/actions";
import {
  CallAvailabilityPanel,
  CallHeading,
  Disclosure,
} from "@/components/cfp/call-overview";
import { ApplicantJourney } from "@/components/cfp/applicant-journey";
import { ApplicantDraftForm } from "@/components/cfp/draft-form";
import { StartDraftForm } from "@/components/cfp/start-draft-form";
import { StatePanel } from "@/components/cfp/state-panel";

export const dynamic = "force-dynamic";

export default async function ApplicantDraftPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string; callSlug: string }>;
  readonly searchParams: Promise<{ saved?: string }>;
}) {
  const [{ workspace, callSlug }, query] = await Promise.all([params, searchParams]);
  const state = await loadApplicantDraftPage(workspace, callSlug);
  if (!state) notFound();
  const baseHref = `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}`;

  return (
    <article className="cfp-page" data-testid="applicant-draft">
      <CallHeading call={state.call} />
      <ApplicantJourney baseHref={baseHref} active="draft" />
      <CallAvailabilityPanel call={state.call} />
      {state.kind === "session-required" ? (
        <StatePanel tone="warning" title="Verify your email to continue">
          <p>Your applicant session is unavailable or expired. Existing durable history is unchanged.</p>
          <p>
            <Link className="cfp-button cfp-button--primary" href={`${baseHref}/verify`}>
              Verify your email
            </Link>
          </p>
        </StatePanel>
      ) : null}
      {state.kind === "draft-required" ? (
        <StartDraftForm workspace={workspace} callSlug={callSlug} />
      ) : null}
      {state.kind === "creation-unconfirmed" ? (
        <StatePanel tone="warning" title="Draft creation needs reconciliation">
          <p>
            A prior draft creation may have completed, but its result could not be confirmed. Creating
            another draft is disabled to protect the durable application record.
          </p>
          <p>Contact the organizer to reconcile the application before taking another action.</p>
        </StatePanel>
      ) : null}
      {state.kind === "draft" ? (
        <ApplicantDraftForm
          key={state.draft.currentRevisionId}
          workspace={workspace}
          callSlug={callSlug}
          draft={state.draft}
          saved={query.saved === "1"}
        />
      ) : null}
      <Disclosure call={state.call} />
      <p className="cfp-back-link">
        <Link href={baseHref}>Back to call details</Link>
      </p>
    </article>
  );
}
