import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./[workspace]/layout.css";

export const metadata: Metadata = {
  title: "Applicant portal · Sympose",
  description: "Apply to a call for proposals through Sympose.",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function ApplicantRootLayout({ children }: { readonly children: ReactNode }) {
  return <div className="cfp-root">{children}</div>;
}
