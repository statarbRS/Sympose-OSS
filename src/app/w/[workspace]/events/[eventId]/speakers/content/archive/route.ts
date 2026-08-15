import { cookies } from "next/headers";

import { hasCapability, resolveSession, SESSION_COOKIE } from "@/server/auth";
import { getDb } from "@/server/db";
import {
  CONTENT_LIBRARY_ARCHIVE_MAX_FORM_BYTES,
  ContentLibraryError,
  createContentLibraryArchive,
} from "@/server/services/content-library";
import { getEvent } from "@/server/services/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
} as const;
const FORM_TOO_LARGE = Symbol("FORM_TOO_LARGE");

function errorResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: PRIVATE_HEADERS });
}

function contentLengthExceedsLimit(request: Request): boolean {
  const value = request.headers.get("content-length");
  if (value === null) return false;
  if (!/^\d+$/u.test(value)) return true;
  const length = Number(value);
  return !Number.isSafeInteger(length) || length > CONTENT_LIBRARY_ARCHIVE_MAX_FORM_BYTES;
}

async function readBoundedFormData(request: Request): Promise<FormData | typeof FORM_TOO_LARGE> {
  if (request.body === null) return new FormData();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > CONTENT_LIBRARY_ARCHIVE_MAX_FORM_BYTES) {
      await reader.cancel().catch(() => undefined);
      return FORM_TOO_LARGE;
    }
    chunks.push(next.value);
  }
  const contentType = request.headers.get("content-type");
  const headers = contentType === null ? undefined : { "content-type": contentType };
  const boundedRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  });
  return boundedRequest.formData();
}

function contentLibraryErrorResponse(error: ContentLibraryError): Response {
  switch (error.code) {
    case "CONTENT_LIBRARY_SELECTION_EMPTY":
      return errorResponse("Select at least one current file.", 400);
    case "CONTENT_LIBRARY_SELECTION_INVALID":
    case "CONTENT_LIBRARY_SELECTION_DUPLICATE":
      return errorResponse("The file selection is invalid.", 400);
    case "CONTENT_LIBRARY_SELECTION_TOO_MANY":
    case "CONTENT_LIBRARY_SELECTION_TOO_LARGE":
      return errorResponse("The selected files exceed archive limits; no archive was created.", 413);
    case "CONTENT_LIBRARY_SELECTION_NOT_FOUND":
    case "CONTENT_LIBRARY_SELECTION_STALE":
    case "CONTENT_LIBRARY_SCOPE_UNAVAILABLE":
      return errorResponse("Not found", 404);
    case "CONTENT_LIBRARY_BYTES_UNAVAILABLE":
      return errorResponse("The selected files could not be read; no archive was created.", 409);
    case "CONTENT_LIBRARY_INTEGRITY_FAILURE":
    case "CONTENT_LIBRARY_ARCHIVE_UNAVAILABLE":
      return errorResponse("The archive is unavailable; no archive was created.", 409);
  }
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly workspace: string; readonly eventId: string }> },
): Promise<Response> {
  try {
    const db = getDb();
    const { workspace, eventId } = await params;
    const session = resolveSession(db, (await cookies()).get(SESSION_COOKIE)?.value);
    if (!session || session.workspaceSlug !== workspace || !hasCapability(session, "phase0.pipeline.manage")) {
      return errorResponse("Not found", 404);
    }
    const event = getEvent(db, session.workspaceId, eventId);
    if (!event) return errorResponse("Not found", 404);
    if (contentLengthExceedsLimit(request)) {
      return errorResponse("The file selection exceeds request limits; no archive was created.", 413);
    }
    let formData: FormData;
    try {
      const parsed = await readBoundedFormData(request);
      if (parsed === FORM_TOO_LARGE) {
        return errorResponse("The file selection exceeds request limits; no archive was created.", 413);
      }
      formData = parsed;
    } catch {
      return errorResponse("The file selection is invalid.", 400);
    }
    const archive = createContentLibraryArchive(db, {
      kind: "organizer",
      workspaceId: session.workspaceId,
      eventId: event.id,
      actorId: session.accountId,
    }, formData.getAll("artifactId"));
    return new Response(new Uint8Array(archive.bytes), {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "content-type": archive.contentType,
        "content-length": String(archive.bytes.byteLength),
        "content-disposition": `attachment; filename="${archive.fileName}"`,
        "x-sympose-archive-files": String(archive.fileCount),
        "x-sympose-uncompressed-bytes": String(archive.uncompressedBytes),
      },
    });
  } catch (error) {
    if (error instanceof ContentLibraryError) return contentLibraryErrorResponse(error);
    return errorResponse("The archive is unavailable; no archive was created.", 500);
  }
}
