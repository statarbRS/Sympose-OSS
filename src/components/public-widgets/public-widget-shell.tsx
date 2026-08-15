import Link from "next/link";
import type { ReactNode } from "react";
import { embedQuery, type EmbedConfiguration } from "@/server/services/public-widgets/embed";
import type { PublicWidgetProjection } from "@/server/services/public-widgets/contracts";
import { embedPath } from "@/app/embed/_paths";
import styles from "./styles.module.css";

export type PublicWidgetSurface = "sessions" | "speakers" | "gallery" | "agenda" | "itinerary" | "configure";

const AUDIENCE_REFERENCE_PATTERN = /^aud1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function canonicalAgendaPath(widget: PublicWidgetProjection): string | null {
  const reference = widget.event.publicReference;
  if (reference !== widget.release.releaseReference || !AUDIENCE_REFERENCE_PATTERN.test(reference)) return null;
  return `/events/${encodeURIComponent(reference)}/agenda`;
}

export function formatWidgetTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatWidgetDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function initials(displayName: string): string {
  return displayName
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function PublicWidgetShell({
  widget,
  active,
  children,
  configuration,
  configurationId,
}: {
  readonly widget: PublicWidgetProjection;
  readonly active: PublicWidgetSurface;
  readonly children: ReactNode;
  readonly configuration?: EmbedConfiguration;
  readonly configurationId?: string | null;
}) {
  const channel = widget.release.channelReference;
  const configurationQuery = configuration ? `?${embedQuery(configuration, configurationId ?? undefined)}` : "";
  const attendeeAgendaHref = canonicalAgendaPath(widget);
  const nav: readonly { readonly label: string; readonly surface: PublicWidgetSurface; readonly suffix: string }[] = [
    { label: "Sessions", surface: "sessions", suffix: "/sessions" },
    { label: "Speakers", surface: "speakers", suffix: "/speakers" },
    { label: "Gallery", surface: "gallery", suffix: "/gallery" },
    { label: "Agenda view", surface: "agenda", suffix: "/agenda" },
    { label: "My itinerary", surface: "itinerary", suffix: "/itinerary" },
  ];
  const configureHref = `${embedPath(channel, "/configure")}${configurationQuery}`;
  return (
    <div
      className={styles.root}
      data-theme={configuration?.theme ?? "light"}
      data-accent={configuration?.accent ?? "teal"}
    >
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <div className={styles.brandBlock}>
            <Link className={styles.brand} href={`${embedPath(channel)}${configurationQuery}`}>
              {widget.event.title}
              <small>Portable presentation surface · sealed release {widget.release.releaseNumber}</small>
            </Link>
            {attendeeAgendaHref ? (
              <Link
                aria-label="Open canonical attendee agenda"
                className={styles.canonicalAgendaLink}
                data-testid="canonical-public-event"
                href={attendeeAgendaHref}
              >
                <span>Attendee entry</span>
                <strong>Open sealed agenda</strong>
              </Link>
            ) : (
              <span
                className={styles.eventLink}
                data-testid="canonical-public-event-unavailable"
                role="status"
              >
                Attendee agenda link unavailable for this surface
              </span>
            )}
          </div>
          <div className={styles.navigationBlock}>
            <nav className={styles.nav} aria-label="Portable presentation surfaces">
              {nav.map((item) => (
                <Link
                  className={styles.navLink}
                  href={`${embedPath(channel, item.suffix)}${configurationQuery}`}
                  aria-current={active === item.surface ? "page" : undefined}
                  key={item.surface}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <nav className={styles.presentationTools} aria-label="Portable presentation tools">
              <span>Publisher tool</span>
              <Link
                aria-current={active === "configure" ? "page" : undefined}
                className={styles.configureLink}
                href={configureHref}
              >
                Configure portable embed
              </Link>
            </nav>
          </div>
        </div>
      </header>
      <main className={styles.main} id="main-content" tabIndex={-1}>
        {children}
        <div className={styles.notice} role="status" data-testid="public-source-release">
          <div className={styles.noticeHeader}>
            <strong>Sealed public release</strong>
            <span className={styles.releaseMeta}>
              This portable surface reads sealed public release {widget.release.releaseNumber}, published {formatWidgetDate(widget.release.sealedAt, widget.event.timezone)}.
            </span>
          </div>
          <details className={styles.scheduleDetails}>
            <summary>About this published program</summary>
            <div className={styles.scheduleDetailsBody}>
              <p>This presentation surface does not read live organizer planning state. The attendee agenda is the canonical event entry; later organizer changes require a newly sealed public release.</p>
            </div>
          </details>
        </div>
        <footer className={styles.footer}>
          Portable presentation surface · {widget.event.timezone} · <Link href={`${embedPath(channel, "/feed")}${configurationQuery}`}>JSON feed</Link>
        </footer>
      </main>
    </div>
  );
}

export function PublicWidgetHero({
  eyebrow,
  title,
  description,
  children,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <section className={styles.hero}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1 className={styles.title}>{title}</h1>
      {description ? <p className={styles.lede}>{description}</p> : null}
      {children}
    </section>
  );
}

export function PublicWidgetBackLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  return <Link className={styles.speakerLink} href={href}>{children}</Link>;
}

export function PublicWidgetSplit({ children }: { readonly children: ReactNode }) {
  return <div className={styles.split}>{children}</div>;
}
