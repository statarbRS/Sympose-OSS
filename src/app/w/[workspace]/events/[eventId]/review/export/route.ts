import { getDb } from "@/server/db";
import {
  exportOrganizerReview,
  OrganizerReviewServiceError,
  type OrganizerReviewSort,
} from "@/server/services/cfp-review/organizer";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

export const dynamic = "force-dynamic";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SORTS: readonly OrganizerReviewSort[] = ["rank", "score", "progress", "submission", "reviewer"];

function badRequest(): Response {
  return new Response("REVIEW_EXPORT_INPUT_INVALID", {
    status: 400,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ workspace: string; eventId: string }> },
): Promise<Response> {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const query = new URL(request.url).searchParams;
  const roundId = query.get("round");
  const format = query.get("format") ?? "csv";
  const sort = query.get("sort") as OrganizerReviewSort | null;
  if (
    !roundId ||
    !IDENTIFIER_PATTERN.test(roundId) ||
    (format !== "csv" && format !== "json") ||
    (sort !== null && !SORTS.includes(sort))
  ) {
    return badRequest();
  }

  try {
    const result = exportOrganizerReview(getDb(), session, {
      workspaceSlug: session.workspaceSlug,
      eventId,
      roundId,
      format,
      ...(sort ? { sort } : {}),
    });
    return new Response(result.content, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${result.fileName}"`,
        "content-type": `${result.mediaType}; charset=utf-8`,
        "x-sympose-local-evidence": result.localEvidence.fingerprint,
      },
    });
  } catch (error) {
    if (error instanceof OrganizerReviewServiceError) {
      if (error.code === "ROUND_NOT_AVAILABLE" || error.code === "EVENT_NOT_AVAILABLE") {
        return new Response("REVIEW_EXPORT_NOT_FOUND", {
          status: 404,
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (error.code === "INPUT_INVALID") return badRequest();
    }
    throw error;
  }
}
