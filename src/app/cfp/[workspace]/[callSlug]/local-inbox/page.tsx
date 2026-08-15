import Link from "next/link";
import { notFound } from "next/navigation";

import { loadApplicantPublicCall } from "@/app/cfp/actions";
import {
  readSimulatedApplicantVerificationDelivery,
  simulatedApplicantVerificationInboxEnabled,
  simulatedApplicantVerificationInboxPath,
} from "@/app/cfp/verification-delivery.server";
import {
  CallAvailabilityPanel,
  CallHeading,
  formatApplicantDateTime,
} from "@/components/cfp/call-overview";
import { ApplicantJourney } from "@/components/cfp/applicant-journey";
import { StatePanel } from "@/components/cfp/state-panel";

export const dynamic = "force-dynamic";

export default async function SimulatedApplicantVerificationInboxPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string; callSlug: string }>;
  readonly searchParams: Promise<{ delivery?: string }>;
}) {
  if (!simulatedApplicantVerificationInboxEnabled()) notFound();

  const [{ workspace, callSlug }, query] = await Promise.all([params, searchParams]);
  const call = await loadApplicantPublicCall(workspace, callSlug);
  if (!call) notFound();
  const delivery = await readSimulatedApplicantVerificationDelivery(workspace, callSlug);
  const verificationPath = `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(
    callSlug,
  )}/verify`;

  return (
    <article className="cfp-page cfp-page--narrow" data-testid="simulated-verification-inbox">
      <CallHeading call={call} />
      <ApplicantJourney baseHref={`/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}`} active="verify" />
      <CallAvailabilityPanel call={call} />
      {delivery ? (
        <StatePanel tone="success" title="Verification link delivered">
          <p>
            The local simulator delivered a one-time link to <strong>{delivery.email}</strong>.
          </p>
          <p>
            It expires {formatApplicantDateTime(delivery.expiresAt, call.timezone)}. Opening it
            removes the simulated delivery from this inbox.
          </p>
          <a
            className="cfp-button cfp-button--primary"
            href={simulatedApplicantVerificationInboxPath(workspace, callSlug, "/open")}
          >
            Open delivered verification link
          </a>
        </StatePanel>
      ) : (
        <StatePanel
          tone={query.delivery === "missing" ? "warning" : "info"}
          title="No delivered verification link"
        >
          <p>Request a new verification link for this call, then return to this local inbox.</p>
        </StatePanel>
      )}
      <p className="cfp-back-link">
        <Link href={verificationPath}>Back to email verification</Link>
      </p>
    </article>
  );
}
