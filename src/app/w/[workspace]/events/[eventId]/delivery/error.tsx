"use client";

import { DeliveryCenterError } from "@/components/delivery-center/delivery-center-states";

export default function Error({ reset }: { readonly error: Error & { digest?: string }; readonly reset: () => void }) {
  return <DeliveryCenterError reset={reset} />;
}
