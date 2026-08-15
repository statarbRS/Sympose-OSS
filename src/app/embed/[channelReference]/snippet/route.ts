import { resolveEmbedRequest } from "../../_lib";
import { buildEmbedSnippet } from "@/server/services/public-widgets/embed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function requestOrigin(httpRequest: Request): string {
  const requestUrl = new URL(httpRequest.url);
  const forwardedProtocol = httpRequest.headers.get("x-forwarded-proto");
  const forwardedHost = httpRequest.headers.get("host");
  if (!forwardedProtocol || !forwardedHost) return requestUrl.origin;
  if (
    (forwardedProtocol !== "http" && forwardedProtocol !== "https") ||
    /[\s,\u0000-\u001f\u007f]/u.test(forwardedHost)
  ) return requestUrl.origin;
  try {
    const forwarded = new URL(`${forwardedProtocol}://${forwardedHost}`);
    if (
      forwarded.username !== "" ||
      forwarded.password !== "" ||
      forwarded.pathname !== "/" ||
      forwarded.search !== "" ||
      forwarded.hash !== ""
    ) return requestUrl.origin;
    return forwarded.origin;
  } catch {
    return requestUrl.origin;
  }
}

export async function GET(
  httpRequest: Request,
  context: { readonly params: Promise<{ channelReference: string }> },
) {
  const { channelReference } = await context.params;
  const requestUrl = new URL(httpRequest.url);
  const embedRequest = resolveEmbedRequest(channelReference, requestUrl.searchParams);
  if (!embedRequest) {
    return new Response("PUBLIC_WIDGET_NOT_FOUND", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new Response(buildEmbedSnippet(channelReference, embedRequest.configuration, requestOrigin(httpRequest), embedRequest.configurationId ?? undefined), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
