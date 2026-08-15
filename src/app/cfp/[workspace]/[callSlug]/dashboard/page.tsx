import Link from "next/link";
import { notFound } from "next/navigation";

import { loadApplicantDashboardPage } from "@/app/cfp/actions";
import {
  CallAvailabilityPanel,
  CallHeading,
  Disclosure,
} from "@/components/cfp/call-overview";
import { ApplicantJourney } from "@/components/cfp/applicant-journey";
import { ApplicantDashboard } from "@/components/cfp/applicant-dashboard";
import { StatePanel } from "@/components/cfp/state-panel";

export const dynamic = "force-dynamic";

export default async function ApplicantDashboardPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; callSlug: string }>;
}) {
  const { workspace, callSlug } = await params;
  const state = await loadApplicantDashboardPage(workspace, callSlug);
  if (!state) notFound();
  const baseHref = `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}`;

  return (
    <article className="cfp-page" data-testid="applicant-dashboard-page">
      <CallHeading call={state.call} />
      <ApplicantJourney baseHref={baseHref} active="dashboard" />
      <CallAvailabilityPanel call={state.call} />
      {state.kind === "session-required" ? (
        <StatePanel tone="warning" title="Verify your email to view application status">
          <p>Your applicant session is unavailable or expired. Existing durable history is unchanged.</p>
          <p>
            <Link className="cfp-button cfp-button--primary" href={`${baseHref}/verify`}>
              Verify your email
            </Link>
          </p>
        </StatePanel>
      ) : null}
      {state.kind === "no-submission" ? (
        <StatePanel title="No application record in this browser session">
          <p>Start or resume a draft after verification. The dashboard will show the durable receipt after submission.</p>
          <p>
            <Link className="cfp-button cfp-button--primary" href={`${baseHref}/draft`}>
              Start or resume application
            </Link>
          </p>
        </StatePanel>
      ) : null}
      {state.kind === "dashboard" ? (
        <ApplicantDashboard
          workspace={workspace}
          callSlug={callSlug}
          call={state.call}
          submission={state.submission}
        />
      ) : null}
      <Disclosure call={state.call} />
      <p className="cfp-back-link">
        <Link href={baseHref}>Back to call details</Link>
      </p>
    </article>
  );
}
