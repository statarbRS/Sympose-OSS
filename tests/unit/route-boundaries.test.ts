import { describe, expect, it, vi } from "vitest";

import nextConfig from "../../next.config";
import DashboardError from "@/app/w/[workspace]/dashboard/error";
import DashboardLoading from "@/app/w/[workspace]/dashboard/loading";
import CfpError from "@/app/w/[workspace]/events/[eventId]/cfp/error";
import CfpLoading from "@/app/w/[workspace]/events/[eventId]/cfp/loading";

type BoundaryProps = {
  readonly label: string;
  readonly reset?: () => void;
};

describe("route boundary configuration", () => {
  it("hides only the Next development indicator", () => {
    expect(nextConfig.devIndicators).toBe(false);
    expect(nextConfig.headers).toBeTypeOf("function");
  });

  it.each([
    ["dashboard", DashboardLoading, DashboardError, "Workspace dashboard"],
    ["organizer CFP", CfpLoading, CfpError, "Call for Proposals"],
  ] as const)("delegates %s loading and error states to the shared surface boundary", (_name, Loading, ErrorBoundary, label) => {
    const loading = Loading();
    expect((loading.props as BoundaryProps).label).toBe(label);

    const reset = vi.fn();
    const error = ErrorBoundary({ error: new globalThis.Error("internal detail"), reset });
    const errorProps = error.props as BoundaryProps;
    expect(errorProps.label).toBe(label);
    expect(errorProps.reset).toBe(reset);
  });
});
