/**
 * Browser-safe public embed path helpers.
 *
 * Keep these separate from the server resolver in `_lib.ts`: that module opens
 * the SQLite-backed configuration repository and must never enter a client
 * component's dependency graph.
 */
export function embedBasePath(channelReference: string): string {
  return `/embed/${encodeURIComponent(channelReference)}`;
}

export function embedPath(channelReference: string, suffix = ""): string {
  return `${embedBasePath(channelReference)}${suffix}`;
}
