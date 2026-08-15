import type { ReactNode } from "react";

import { CfpShell } from "@/components/cfp/cfp-shell";

export default function ApplicantWorkspaceLayout({ children }: { readonly children: ReactNode }) {
  return <CfpShell>{children}</CfpShell>;
}
