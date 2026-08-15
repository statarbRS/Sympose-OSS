import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveEvaluatorBuildIdentity } from "@/components/evaluator-walkthrough/build-identity";
import { EvaluatorWalkthrough } from "@/components/evaluator-walkthrough/evaluator-walkthrough";
import { getDb } from "@/server/db";
import { EVALUATOR_EVENT_ID, EVALUATOR_WORKSPACE_ID } from "@/server/evaluator-demo";
import { resolveCurrentPublicWidgetBinding } from "@/server/services/public-widgets";

export const metadata: Metadata = {
  title: "Evaluator walkthrough",
  description: "A public, ordered route map for the synthetic Sympose evaluator journey, exact-candidate identity, and explicit local persistence boundaries.",
  robots: { index: true, follow: true },
};

export default async function WalkthroughPage() {
  await connection();
  const buildIdentity = resolveEvaluatorBuildIdentity(process.env.SYMPOSE_BUILD_SHA);
  const binding = resolveCurrentPublicWidgetBinding(getDb(), {
    workspaceId: EVALUATOR_WORKSPACE_ID,
    eventId: EVALUATOR_EVENT_ID,
  });
  return (
    <EvaluatorWalkthrough
      buildIdentity={buildIdentity}
      releaseReference={binding?.releaseReference ?? null}
    />
  );
}
