import type { ReactNode } from "react";

import {
  getRouteSession,
  requireWorkspaceShellRoute,
} from "@/server/workspace-session";
import { capabilitiesForSession } from "@/server/auth";
import { SignOutForm } from "@/components/workspace-dashboard";
import { ProductShell } from "@/components/product-shell/product-shell";

import "./shell.css";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const session = await getRouteSession();
  // Child pages enforce their own purpose capability; the parent projects only the union of
  // authorized organizer-shell destinations and never supplies that shell to reviewer sessions.
  requireWorkspaceShellRoute(session, workspace);
  const accountInitials = session.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <ProductShell
      workspaceSlug={session.workspaceSlug}
      workspaceName={session.workspaceName}
      displayName={session.displayName}
      email={session.email}
      accountInitials={accountInitials}
      capabilities={capabilitiesForSession(session)}
      accountControl={<SignOutForm />}
    >
      {children}
    </ProductShell>
  );
}
