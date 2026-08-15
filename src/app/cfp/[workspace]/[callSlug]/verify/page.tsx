import Link from "next/link";
import { notFound } from "next/navigation";

import { loadApplicantVerificationPage } from "@/app/cfp/actions";
import { CallAvailabilityPanel, CallHeading } from "@/components/cfp/call-overview";
import { ApplicantJourney } from "@/components/cfp/applicant-journey";
import { StatePanel } from "@/components/cfp/state-panel";
import {
  simulatedApplicantVerificationInboxEnabled,
  simulatedApplicantVerificationInboxPath,
} from "@/app/cfp/verification-delivery.server";
import {
  CompleteVerificationForm,
  RequestVerificationForm,
} from "@/components/cfp/verification-forms";

export const dynamic = "force-dynamic";

export default async function ApplicantVerificationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string; callSlug: string }>;
  readonly searchParams: Promise<{ link?: string }>;
}) {
  const [{ workspace, callSlug }, query] = await Promise.all([params, searchParams]);
  const view = await loadApplicantVerificationPage(workspace, callSlug);
  if (!view) notFound();
  const callHref = `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}`;
  const showSimulatedInbox = simulatedApplicantVerificationInboxEnabled();

  return (
    <article className="cfp-page cfp-page--narrow" data-testid="applicant-verification">
      <CallHeading call={view.call} />
      <ApplicantJourney baseHref={callHref} active="verify" />
      <CallAvailabilityPanel call={view.call} />
      {query.link === "invalid" ? (
        <StatePanel tone="error" title="This verification link cannot be used">
          <p>Request a new link below. Link errors are deliberately non-specific.</p>
        </StatePanel>
      ) : null}
      {view.hasPendingVerification ? (
        <CompleteVerificationForm
          workspace={workspace}
          callSlug={callSlug}
          callName={view.call.name}
        />
      ) : (
        <RequestVerificationForm
          workspace={workspace}
          callSlug={callSlug}
          callName={view.call.name}
        />
      )}
      {!view.hasPendingVerification && showSimulatedInbox ? (
        <StatePanel title="Local simulated delivery">
          <p>
            This non-production environment keeps the latest delivered verification link in an
            inbox scoped to this browser, workspace, call, and email request.
          </p>
          <p>
            <Link href={simulatedApplicantVerificationInboxPath(workspace, callSlug)}>
              Open local simulated inbox
            </Link>
          </p>
        </StatePanel>
      ) : null}
      <p className="cfp-back-link">
        <Link href={callHref}>Back to call details</Link>
      </p>
    </article>
  );
}
