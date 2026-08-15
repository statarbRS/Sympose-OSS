import { resolveEmbedRequest } from "../../_lib";
import { buildIcsCalendar, IcsExportInputError } from "@/server/services/public-widgets/ics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function requestedReferences(request: Request): readonly string[] | undefined {
  const value = new URL(request.url).searchParams.get("sessions");
  if (!value) return undefined;
  if (value.length > 4096) throw new IcsExportInputError("Calendar selection is too large.");
  return value.split(",").filter(Boolean);
}
export async function GET(
  httpRequest: Request,
  context: { readonly params: Promise<{ channelReference: string }> },
) {
  const { channelReference } = await context.params;
  const embedRequest = resolveEmbedRequest(channelReference, new URL(httpRequest.url).searchParams);
  if (!embedRequest) {
    return new Response("PUBLIC_WIDGET_NOT_FOUND", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    const ics = buildIcsCalendar(embedRequest.widget, requestedReferences(httpRequest));
    return new Response(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="sympose-${encodeURIComponent(channelReference)}.ics"`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    if (error instanceof IcsExportInputError) {
      return new Response("ICS_EXPORT_INPUT_INVALID", {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    }
    throw error;
  }
}
