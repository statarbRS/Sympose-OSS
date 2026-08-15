import { Buffer } from "node:buffer";

import { NextResponse } from "next/server";

import { verificationCookieName } from "@/app/cfp/cookie-scope.server";
import {
  clearSimulatedApplicantVerificationDelivery,
  readOpenableSimulatedApplicantVerificationDelivery,
  simulatedApplicantVerificationInboxEnabled,
  simulatedApplicantVerificationInboxPath,
} from "@/app/cfp/verification-delivery.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectResponse(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: location,
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ workspace: string; callSlug: string }> },
) {
  if (!simulatedApplicantVerificationInboxEnabled()) {
    return new NextResponse("Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { workspace, callSlug } = await context.params;
  const delivery = await readOpenableSimulatedApplicantVerificationDelivery(
    workspace,
    callSlug,
  );
  const destination = delivery
    ? `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}/verify`
    : `${simulatedApplicantVerificationInboxPath(workspace, callSlug)}?delivery=missing`;
  const response = redirectResponse(destination);

  if (delivery) {
    response.cookies.set(
      verificationCookieName(workspace, callSlug),
      Buffer.from(
        JSON.stringify({
          version: 1,
          workspace,
          call: callSlug,
          verificationId: delivery.verificationId,
          token: delivery.token,
        }),
        "utf8",
      ).toString("base64url"),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/cfp",
        maxAge: 15 * 60,
        priority: "high",
      },
    );
  }

  clearSimulatedApplicantVerificationDelivery(response.cookies, workspace, callSlug);
  return response;
}
