import Link from "next/link";
import type { ReactNode } from "react";

export function StatePanel({
  tone = "info",
  title,
  children,
}: {
  readonly tone?: "info" | "warning" | "error" | "success";
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={`cfp-state-panel cfp-state-panel--${tone}`}>
      <h2>{title}</h2>
      <div>{children}</div>
    </section>
  );
}

export function ApplicantRouteLink({
  href,
  children,
  primary = false,
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly primary?: boolean;
}) {
  return (
    <Link className={`cfp-button${primary ? " cfp-button--primary" : ""}`} href={href}>
      {children}
    </Link>
  );
}
