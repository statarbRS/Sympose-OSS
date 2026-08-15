"use client";
import { SurfaceError } from "../_components/surface-route-states";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) { return <SurfaceError error={error} reset={reset} label="Operations Handoff" />; }
