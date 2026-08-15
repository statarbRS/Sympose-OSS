import { resolveEmbedRequest } from "../../_lib";
import { buildPublicWidgetFeed } from "@/server/services/public-widgets/embed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  httpRequest: Request,
  context: { readonly params: Promise<{ channelReference: string }> },
) {
  const { channelReference } = await context.params;
  const embedRequest = resolveEmbedRequest(channelReference, new URL(httpRequest.url).searchParams);
  if (!embedRequest) {
    return new Response(JSON.stringify({ error: "PUBLIC_WIDGET_NOT_FOUND" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const feed = buildPublicWidgetFeed(embedRequest.widget);
  const attendeeFeed = {
    channelReference: feed.channelReference,
    releaseNumber: feed.releaseNumber,
    sealedAt: feed.sealedAt,
    releaseReference: feed.releaseReference,
    event: feed.event,
    sessions: feed.sessions,
    speakers: feed.speakers,
  };
  return new Response(JSON.stringify(attendeeFeed), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
