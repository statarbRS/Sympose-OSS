import type { Metadata } from "next";

import { Fingerprint, formatDateTime } from "@/components/truth";
import { isDenialError, type DenialError } from "@/server/auth";
import { getDb } from "@/server/db";
import { resolvePortalAccess, type PortalAccess } from "@/server/services/publication";
import styles from "../portal.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Personal agenda · Sympose MVP",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function PortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  let access: PortalAccess | null = null;
  let denial: DenialError | null = null;
  try {
    access = resolvePortalAccess(getDb(), token);
  } catch (error) {
    if (isDenialError(error)) {
      denial = error;
    } else {
      throw error;
    }
  }

  if (!access) {
    return (
      <div className={`${styles.page} portal-page`}>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <header className={`${styles.topbar} portal-topbar`}>
          <div className={`${styles.topbarInner} portal-topbar__inner`}>
            <p className={`${styles.brand} portal-topbar__brand`}>Sympose participant portal</p>
            <span className={`${styles.topbarState} portal-topbar__state`}>Sealed audience projection</span>
          </div>
        </header>
        <main className={`${styles.main} portal-main`} id="main-content" tabIndex={-1}>
          <section className={`${styles.surface} portal-surface portal-denied`} data-testid="portal-denied">
            <p className={`${styles.eyebrow} portal-surface__eyebrow`}>Sealed projection access</p>
            <p><span className={styles.deniedCode}>{denial?.code ?? "TOKEN_INVALID"}</span></p>
            <h1>Agenda unavailable</h1>
            <div className={`${styles.notice} portal-notice portal-notice--denied`}>
              <strong>Sealed projection access</strong>
              <span>This participant portal is token-scoped and cannot be opened with this link.</span>
            </div>
            <p className={styles.muted}>
              {denial?.message ?? "This agenda link could not be opened."} Ask the organizer for a
              current link if you still need access.
            </p>
          </section>
        </main>
      </div>
    );
  }

  const nextItem = access.agenda.items[0];

  return (
    <div className={`${styles.page} portal-page`}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className={`${styles.topbar} portal-topbar`}>
        <div className={`${styles.topbarInner} portal-topbar__inner`}>
          <p className={`${styles.brand} portal-topbar__brand`}>Sympose participant portal</p>
          <span className={`${styles.topbarState} portal-topbar__state`}>Sealed audience projection</span>
        </div>
      </header>
      <main className={`${styles.main} portal-main`} id="main-content" tabIndex={-1}>
        <article className={`${styles.surface} portal-surface`} data-testid="personal-agenda">
          <header className={`${styles.surfaceHeader} portal-surface__header`}>
            <p className={`${styles.eyebrow} portal-surface__eyebrow`}>Sealed participant agenda</p>
            <h1>{access.event.name}</h1>
          </header>
          <aside className={`${styles.notice} portal-notice`} aria-label="Sealed projection notice">
            <strong>Sealed projection</strong>
            <span>This agenda is a sealed audience projection and does not update from live organizer planning state.</span>
          </aside>
          <p className={styles.lede}>
            Personal agenda for <strong>{access.personName}</strong> ({access.email}). This page is a
            sealed audience projection, not a live read from organizer planning state.
          </p>
          <section className={styles.nowSummary} aria-labelledby="what-matters-now-title" data-role-instrument="participant">
            <div>
              <p className={styles.nowEyebrow}>What matters now</p>
              <h2 id="what-matters-now-title">{nextItem ? "Your next agenda item" : "Your agenda is ready"}</h2>
              <p>{nextItem ? "Start with the first item in this sealed release. Times are shown in the event timezone." : "No sessions are currently listed in this sealed release."}</p>
            </div>
            {nextItem ? (
              <div className={styles.nextItem}>
                <strong>{nextItem.programUnitName}</strong>
                <span>{nextItem.role}</span>
                <time dateTime={nextItem.startsAt}>{formatDateTime(nextItem.startsAt)}</time>
              </div>
            ) : null}
          </section>
          <dl className="kv-list portal-meta-grid">
            <div className="kv"><dt>Event timezone</dt><dd>{access.event.timezone}</dd></div>
            <div className="kv"><dt>Release sealed</dt><dd>{formatDateTime(access.sealedAt)}</dd></div>
            <div className="kv"><dt>Release fingerprint</dt><dd><Fingerprint value={access.releaseFingerprint} /></dd></div>
          </dl>
          <h2 className={`${styles.agendaTitle} portal-card__agenda-title portal-surface__agenda-title`}>Your agenda</h2>
          <div className="table-wrap portal-agenda-region" role="region" aria-label="Your agenda. Scroll horizontally for every column." tabIndex={0}>
            <table className="table">
              <thead><tr><th scope="col">Session</th><th scope="col">Role</th><th scope="col">Starts</th><th scope="col">Ends</th></tr></thead>
              <tbody>
                {access.agenda.items.map((item) => (
                  <tr key={`${item.programUnitId}-${item.role}`}>
                    <td><strong>{item.programUnitName}</strong></td>
                    <td>{item.role}</td>
                    <td>{formatDateTime(item.startsAt)}</td>
                    <td>{formatDateTime(item.endsAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </main>
    </div>
  );
}
