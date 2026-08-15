"use client";

import { SurfaceError } from "../_components/surface-route-states";

export default function Error({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  return <SurfaceError error={error} reset={reset} label="Call for Proposals" />;
}
