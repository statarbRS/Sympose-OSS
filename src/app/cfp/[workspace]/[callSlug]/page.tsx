import { notFound } from "next/navigation";

import { loadApplicantPublicCall } from "@/app/cfp/actions";
import {
  CallActions,
  CallAvailabilityPanel,
  CallHeading,
  Disclosure,
  FormPreview,
} from "@/components/cfp/call-overview";
import { ApplicantJourney } from "@/components/cfp/applicant-journey";

export const dynamic = "force-dynamic";

export default async function ApplicantCallPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; callSlug: string }>;
}) {
  const { workspace, callSlug } = await params;
  const call = await loadApplicantPublicCall(workspace, callSlug);
  if (!call) notFound();

  return (
    <article className="cfp-page" data-testid="applicant-call">
      <CallHeading call={call} />
      <ApplicantJourney
        baseHref={`/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}`}
        active="overview"
        availability={call.availability}
      />
      <CallAvailabilityPanel call={call} />
      <CallActions workspace={workspace} call={call} />
      <div className="cfp-content-grid">
        <Disclosure call={call} />
        <FormPreview call={call} />
      </div>
    </article>
  );
}
