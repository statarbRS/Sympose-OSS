import type { ReactNode } from "react";

export type TruthTone =
  | "qualified"
  | "assigned"
  | "accepted"
  | "attended"
  | "published"
  | "offered"
  | "pending"
  | "declined"
  | "denied"
  | "revoked"
  | "candidate"
  | "approved"
  | "active"
  | "neutral";

export function Badge({ tone, children }: { tone: TruthTone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Fingerprint({ value, label }: { value: string; label?: string }) {
  const short = value.length > 16 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
  return (
    <code className="fp" title={`${label ?? "SHA-256 fingerprint"}: ${value}`}>
      {short}
    </code>
  );
}

export function ledgerBadge(entry: {
  kind: "truth" | "projection";
  layer: string | null;
  projection: string | null;
  title: string;
}): {
  label: string;
  tone: TruthTone;
} {
  if (entry.kind === "projection") {
    if (entry.projection === "proposed-assignment") {
      return { label: "Proposed", tone: "candidate" };
    }
    if (entry.projection === "publication") {
      return { label: "Published", tone: "published" };
    }
    return { label: entry.projection ?? "Projection", tone: "neutral" };
  }
  switch (entry.layer) {
    case "candidate":
      return { label: "Qualified", tone: "qualified" };
    case "decision":
      return { label: "Approved", tone: "approved" };
    case "commitment":
      if (entry.title.includes("accepted")) {
        return { label: "Accepted", tone: "accepted" };
      }
      if (entry.title.includes("declined")) {
        return { label: "Declined", tone: "declined" };
      }
      return { label: "Offered", tone: "offered" };
    case "operational":
      return { label: "Attended", tone: "attended" };
    default:
      return { label: entry.layer ?? "Truth", tone: "neutral" };
  }
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}
