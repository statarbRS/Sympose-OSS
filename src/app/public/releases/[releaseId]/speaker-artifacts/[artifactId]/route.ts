import { getDb } from "@/server/db";
import { readPublishedSpeakerHeadshotByAudienceReference } from "@/server/services/artifact-records";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function notFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\\r\n]/gu, "_") || "headshot.png";
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly releaseId: string; readonly artifactId: string }> },
): Promise<Response> {
  try {
    const { releaseId, artifactId } = await params;
    const result = readPublishedSpeakerHeadshotByAudienceReference(getDb(), {
      releaseReference: releaseId,
      artifactReference: artifactId,
    });
    if (!result) return notFoundResponse();
    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "content-type": result.record.mediaType,
        "content-length": String(result.bytes.byteLength),
        // Original upload filenames are organizer-owned metadata and may contain canonical IDs.
        "content-disposition": contentDisposition("speaker-headshot.png"),
        // Anonymous authority follows the mutable current-release pointer, so a successful response
        // must be re-authorized instead of surviving supersession in a browser or shared cache.
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return notFoundResponse();
  }
}
