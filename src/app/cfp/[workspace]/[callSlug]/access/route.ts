import { Buffer } from "node:buffer";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { verificationCookieName } from "@/app/cfp/cookie-scope.server";

const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/u;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { readonly params: Promise<{ workspace: string; callSlug: string }> },
) {
  const { workspace, callSlug } = await context.params;
  const verificationId = request.nextUrl.searchParams.get("verification");
  const token = request.nextUrl.searchParams.get("token");
  const valid =
    SLUG_PATTERN.test(workspace) &&
    SLUG_PATTERN.test(callSlug) &&
    typeof verificationId === "string" &&
    IDENTIFIER_PATTERN.test(verificationId) &&
    typeof token === "string" &&
    RAW_TOKEN_PATTERN.test(token);

  // Keep the redirect relative. Next can normalize the request authority to an
  // internal host behind a dev server or reverse proxy; an absolute redirect
  // would then strand this host-scoped cookie on a different authority.
  const destination =
    `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}/verify` +
    (valid ? "" : "?link=invalid");
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: destination },
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  const cookieName = verificationCookieName(workspace, callSlug);

  if (valid) {
    response.cookies.set(
      cookieName,
      Buffer.from(
        JSON.stringify({
          version: 1,
          workspace,
          call: callSlug,
          verificationId,
          token,
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
  } else {
    response.cookies.set(cookieName, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/cfp",
      maxAge: 0,
    });
  }

  return response;
}
