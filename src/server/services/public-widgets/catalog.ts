import {
  parsePublishedEventProjection,
  toPublicWidgetProjection,
  type PublishedEventProjection,
  type PublicWidgetProjection,
} from "./contracts";

const CHANNEL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WORKSPACE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface PublishedProjectionBinding {
  readonly workspaceId: string;
  readonly projection: PublishedEventProjection;
}

export interface PublicWidgetLookup {
  /** Derived by the server/integration binding, never accepted from the browser. */
  readonly workspaceId: string;
  readonly channelReference: string;
  readonly releaseId?: string;
}

export interface PublicWidgetCatalog {
  resolve(lookup: PublicWidgetLookup): PublicWidgetProjection;
}

export class PublicWidgetNotFoundError extends Error {
  readonly code = "PUBLIC_WIDGET_NOT_FOUND" as const;

  constructor() {
    super("Public widget not found.");
    this.name = "PublicWidgetNotFoundError";
  }
}

function catalogKey(workspaceId: string, channelReference: string): string {
  return `${workspaceId}\u0000${channelReference}`;
}

function validateReference(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value.length > 0 && pattern.test(value);
}

function assertAuthorizedRelease(projection: PublishedEventProjection): void {
  if (
    projection.release.status !== "SEALED" ||
    projection.release.audience !== "PUBLIC" ||
    projection.release.approval !== "APPROVED" ||
    !projection.release.current ||
    projection.release.revokedAt !== null
  ) {
    throw new PublicWidgetNotFoundError();
  }
}

class MemoryPublicWidgetCatalog implements PublicWidgetCatalog {
  private readonly entries: ReadonlyMap<
    string,
    { readonly releaseId: string; readonly widget: PublicWidgetProjection }
  >;

  constructor(bindings: readonly PublishedProjectionBinding[]) {
    const entries = new Map<
      string,
      { readonly releaseId: string; readonly widget: PublicWidgetProjection }
    >();
    for (const binding of bindings) {
      if (!validateReference(binding.workspaceId, WORKSPACE_REFERENCE_PATTERN)) {
        throw new Error("PUBLIC_WIDGET_BINDING_INVALID");
      }
      const projection = parsePublishedEventProjection(binding.projection);
      if (projection.workspaceId !== binding.workspaceId) {
        throw new Error("PUBLIC_WIDGET_BINDING_TENANT_MISMATCH");
      }
      assertAuthorizedRelease(projection);
      const key = catalogKey(binding.workspaceId, projection.release.channelReference);
      if (entries.has(key)) {
        throw new Error("PUBLIC_WIDGET_BINDING_DUPLICATE_CHANNEL");
      }
      entries.set(key, {
        releaseId: projection.releaseId,
        widget: toPublicWidgetProjection(projection),
      });
    }
    this.entries = entries;
  }

  resolve(lookup: PublicWidgetLookup): PublicWidgetProjection {
    if (lookup === null || typeof lookup !== "object") {
      throw new PublicWidgetNotFoundError();
    }
    if (
      !validateReference(lookup.workspaceId, WORKSPACE_REFERENCE_PATTERN) ||
      !validateReference(lookup.channelReference, CHANNEL_REFERENCE_PATTERN)
    ) {
      throw new PublicWidgetNotFoundError();
    }
    const entry = this.entries.get(catalogKey(lookup.workspaceId, lookup.channelReference));
    if (!entry) throw new PublicWidgetNotFoundError();
    if (lookup.releaseId !== undefined && lookup.releaseId !== entry.releaseId) {
      // The integration seam can require an exact immutable release binding. The
      // public channel URL itself never exposes or accepts this internal reference.
      throw new PublicWidgetNotFoundError();
    }
    return entry.widget;
  }
}

export function createPublicWidgetCatalog(
  bindings: readonly PublishedProjectionBinding[],
): PublicWidgetCatalog {
  return new MemoryPublicWidgetCatalog(bindings);
}
