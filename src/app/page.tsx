import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getDb } from "@/server/db";
import { toPlainData } from "@/server/canonical";
import { hasCapability, resolveSession, SESSION_COOKIE } from "@/server/auth";
import {
  listLoginChoices,
  listSyntheticReviewerChoices,
} from "@/server/services/queries";
import { LoginForm, type LoginGroup } from "@/components/login-form";
import styles from "@/app/landing.module.css";
import { ReviewerEntry } from "@/components/reviewer-entry";
import {
  DEVFLOW_EVALUATOR_PROFILE,
  EVALUATOR_CALL_SLUG,
  EVALUATOR_COMPATIBILITY_CALL_SLUG,
  EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
  EVALUATOR_EVENT_ID,
  EVALUATOR_WORKSPACE_ID,
  EVALUATOR_WORKSPACE_SLUG,
} from "@/server/evaluator-demo";
import { getEvent } from "@/server/services/events";
import { resolveCurrentDurablePublicAgenda } from "@/server/services/public-agenda";
import { resolveCurrentPublicWidgetBinding } from "@/server/services/public-widgets";
import { ProductionAccess } from "@/components/production-access";
import { productionBootstrapStatus } from "@/server/production-auth";
import { runtimeModeState } from "@/server/runtime-mode";

export const dynamic = "force-dynamic";

function formatLandingEventTime(value: string, timezone: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return `Unformatted timestamp · ${value}`;
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(instant);
    return `${formatted} · ${timezone}`;
  } catch {
    try {
      const fallback = new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(instant);
      return `${fallback} · UTC fallback; requested timezone ${timezone} unavailable`;
    } catch {
      return `Unformatted timestamp · ${value}`;
    }
  }
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; attendee?: string }>;
}) {
  const { reason, attendee } = await searchParams;
  const runtimeMode = runtimeModeState();
  if (runtimeMode === "unconfigured") {
    return (
      <main className={styles.landing} id="landing-content">
        <div className={styles.frame}>
          <header className={styles.hero}>
            <p className={styles.eyebrow}>Runtime configuration required</p>
            <h1>Sympose is not configured.</h1>
            <p className={styles.heroLead}>Select either the production or synthetic-evaluator data mode before opening the application.</p>
          </header>
        </div>
      </main>
    );
  }
  if (runtimeMode === "production") {
    const productionDb = getDb();
    const productionStore = await cookies();
    const productionSession = resolveSession(productionDb, productionStore.get(SESSION_COOKIE)?.value);
    if (productionSession && hasCapability(productionSession, "phase0.pipeline.manage")) {
      redirect(`/w/${productionSession.workspaceSlug}/dashboard`);
    }
    if (productionSession && hasCapability(productionSession, "cfp.review")) {
      redirect(`/review/${productionSession.workspaceSlug}/queue`);
    }
    let bootstrapStatus: ReturnType<typeof productionBootstrapStatus> = "UNAVAILABLE";
    try {
      bootstrapStatus = productionBootstrapStatus(productionDb);
    } catch {
      bootstrapStatus = "UNAVAILABLE";
    }
    return <ProductionAccess bootstrapStatus={bootstrapStatus} sessionExpired={reason === "session-expired"} />;
  }
  const db = getDb();
  const store = await cookies();
  const session = resolveSession(db, store.get(SESSION_COOKIE)?.value);
  const attendeeEvent = getEvent(db, EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID);
  const attendeeBinding = attendeeEvent
    ? resolveCurrentPublicWidgetBinding(db, {
        workspaceId: EVALUATOR_WORKSPACE_ID,
        eventId: attendeeEvent.id,
      })
    : null;
  const attendeeReleaseReference = attendeeBinding?.releaseReference ?? null;
  const attendeeProjection = attendeeReleaseReference
    ? resolveCurrentDurablePublicAgenda(db, attendeeReleaseReference)
    : null;
  const attendeeAgendaAvailable = Boolean(
    attendeeBinding &&
      attendeeReleaseReference &&
      attendeeProjection &&
      attendeeProjection.event.slug === attendeeReleaseReference &&
      attendeeProjection.release.releaseReference === attendeeReleaseReference,
  );
  const attendeeRelease = attendeeAgendaAvailable && attendeeBinding && attendeeProjection
    ? { binding: attendeeBinding, projection: attendeeProjection }
    : null;
  if (attendee === "agenda") {
    if (attendeeAgendaAvailable && attendeeReleaseReference) {
      redirect(`/events/${encodeURIComponent(attendeeReleaseReference)}/agenda`);
    }
    redirect("/#attendee-agenda-status");
  }
  if (session && hasCapability(session, "phase0.pipeline.manage")) {
    redirect(`/w/${session.workspaceSlug}/dashboard`);
  }
  if (session && hasCapability(session, "cfp.review")) {
    redirect(`/review/${session.workspaceSlug}/queue`);
  }

  const choices = listLoginChoices(db);
  const groups: LoginGroup[] = [];
  for (const choice of choices) {
    let group = groups.find((g) => g.workspaceSlug === choice.workspaceSlug);
    if (!group) {
      group = {
        workspaceName: choice.workspaceName,
        workspaceSlug: choice.workspaceSlug,
        accounts: [],
      };
      groups.push(group);
    }
    group.accounts.push(toPlainData({
      accountId: choice.accountId,
      email: choice.email,
      displayName: choice.displayName,
      role: choice.role,
    }));
  }
  const reviewerChoices = listSyntheticReviewerChoices(db).map(toPlainData);
  const attendeeAgendaHref = attendeeAgendaAvailable && attendeeReleaseReference
    ? `/events/${encodeURIComponent(attendeeReleaseReference)}/agenda`
    : "#attendee-agenda-status";

  return (
    <main className={styles.landing} id="landing-content" tabIndex={-1}>
      <a className={styles.skipLink} href="#workspace-entry">
        Skip to workspace entry
      </a>
      <div className={styles.frame}>
        <header className={styles.hero}>
          <div className={styles.utilityRow}>
            <span className={styles.wordmark}>
              <span className={styles.wordmarkMark} aria-hidden="true">
                S
              </span>
              Sympose
            </span>
            <span className={styles.utilityLabel}>Evaluator landing</span>
          </div>
          <div className={styles.heroGrid}>
            <div className={styles.heroCopy}>
              <p className={styles.eyebrow}>Event operations · Evaluator walkthrough</p>
              <h1>See how proposals become a published event program.</h1>
              <p className={styles.heroLead}>
                Follow one seeded Acme journey as an organizer, reviewer, applicant, speaker, or
                attendee—from Mina Park’s accepted proposal to the sealed public program.
              </p>
              <div className={styles.heroActions}>
                <button
                  className={styles.primaryLink}
                  type="submit"
                  form="organizer-login-form"
                  data-testid="organizer-primary-cta"
                >
                  Start with an organizer workspace <span aria-hidden="true">↓</span>
                </button>
                <span className={styles.heroMeta}>No account creation required</span>
              </div>
            </div>
          </div>
          <aside className={styles.disclosure} aria-label="Fixture data disclosure">
            <span className={styles.disclosureMark} aria-hidden="true">
              i
            </span>
            <div>
              <strong>Local synthetic fixture</strong>
              <p>
                This install uses seeded records only. No real participant or organizer data is
                used, and no real email is sent.
              </p>
            </div>
          </aside>
        </header>

        <div className={styles.content}>
          <section
            className={`${styles.personaSection} ${styles.personaSectionPrimary}`}
            aria-labelledby="persona-entry-title"
            data-testid="persona-chooser"
          >
            <div className={styles.sectionHeader}>
              <span className={styles.sectionNumber} aria-hidden="true">
                01
              </span>
              <div>
                <p className={styles.sectionKicker}>Choose one perspective</p>
                <h2 id="persona-entry-title">Evaluator persona entry points</h2>
                <p className={styles.sectionCopy}>
                  Choose a role to follow the same evidence-to-publication journey from its direct
                  entry point.
                </p>
              </div>
            </div>
            <div className={styles.personaGrid}>
              <article
                className={`${styles.personaCard} ${styles.personaCardEntry} ${styles.personaCardFeatured}`}
                id="workspace-entry"
                aria-labelledby="workspace-entry-title"
              >
                <div className={styles.personaCardTopline}>
                  <span className={styles.roleTag}>Organizer</span>
                  <span className={styles.personaState}>Workspace session</span>
                </div>
                <h3 id="workspace-entry-title">Choose an organizer workspace</h3>
                <p>
                  Run the seeded organizer path from intake and review through plan evidence,
                  speaker operations, and a sealed public release.
                </p>
                {reason === "session-expired" ? (
                  <p className={`${styles.status} alert alert--info notice`} role="status">
                    Your server session expired — sign in again.
                  </p>
                ) : null}
                <div className={styles.workspaceBody}>
                  <LoginForm groups={groups} />
                  <p className={styles.helperText}>
                    <strong>Tip:</strong> Choose Acme for the complete journey. DevFlow remains a
                    secondary compatibility reference.
                  </p>
                </div>
              </article>
              <article className={`${styles.personaCard} ${styles.personaCardEntry}`} id="reviewer-entry">
                <div className={styles.personaCardTopline}>
                  <span className={styles.roleTag}>Reviewer</span>
                  <span className={styles.personaState}>Authenticated</span>
                </div>
                <h3>Review an assigned proposal</h3>
                <p id="reviewer-session-required">Open the assigned proposal with a real reviewer-capability session.</p>
                <ReviewerEntry choices={reviewerChoices} />
              </article>
              <article className={`${styles.personaCard} ${styles.personaCardCompact}`}>
                <div className={styles.personaCardTopline}>
                  <span className={styles.roleTag}>Applicant</span>
                  <span className={styles.personaState}>Public CFP</span>
                </div>
                <h3>Submit a proposal</h3>
                <p>Inspect the public CFP, required fields, and the conditional workshop-plan field.</p>
                <Link
                  className={styles.personaLink}
                  href={`/cfp/${EVALUATOR_WORKSPACE_SLUG}/${EVALUATOR_CALL_SLUG}`}
                >
                  Open Stagecraft 2026 CFP <span aria-hidden="true">↗</span>
                </Link>
              </article>
              <article className={`${styles.personaCard} ${styles.personaCardCompact}`}>
                <div className={styles.personaCardTopline}>
                  <span className={styles.roleTag}>Speaker</span>
                  <span className={styles.personaState}>Accepted session</span>
                </div>
                <h3>Prepare a session</h3>
                <p>Continue Mina Park’s accepted proposal into her speaker tasks, exact content versions, and published profile.</p>
                <Link
                  className={styles.personaLink}
                  href="/speaker/entry"
                >
                  Open scoped speaker portal <span aria-hidden="true">↗</span>
                </Link>
              </article>
              <article className={`${styles.personaCard} ${styles.personaCardCompact}`}>
                <div className={styles.personaCardTopline}>
                  <span className={styles.roleTag}>Attendee</span>
                  <span className={styles.personaState}>No sign-in</span>
                </div>
                <h3>Browse the published program</h3>
                <p>
                  Browse the policy-filtered public program and its sessions, speakers, gallery,
                  agenda, and itinerary without signing in.
                </p>
                <div className={styles.actionStack}>
                  <Link className={styles.personaLink} href={attendeeAgendaAvailable && attendeeReleaseReference ? `/embed/${encodeURIComponent(attendeeReleaseReference)}` : attendeeAgendaHref}>
                    Open public program <span aria-hidden="true">↗</span>
                  </Link>
                  <p className={styles.attendeeAuxiliary}>
                    {attendeeAgendaAvailable ? "Validated sealed agenda:" : "Agenda status:"}{" "}
                    <Link className={styles.inlineLink} href={attendeeAgendaHref}>
                      {attendeeAgendaAvailable ? "Open current attendee agenda" : "Show attendee availability"}
                    </Link>
                  </p>
                </div>
              </article>
            </div>
          </section>

          <div className={styles.supportGrid}>
            <aside
              className={`${styles.disclosure} ${styles.compatibilityDisclosure}`}
              aria-label="DevFlow compatibility disclosure"
              data-testid="devflow-compatibility-profile"
            >
              <span className={styles.disclosureMark} aria-hidden="true">i</span>
              <div>
                <div className={styles.compatibilityHeader}>
                  <div>
                    <p className={styles.sectionKicker}>Pinned compatibility profile</p>
                    <h2 id="compatibility-profile-title">{DEVFLOW_EVALUATOR_PROFILE.eventName}</h2>
                  </div>
                  <span className={styles.compatibilityState}>Local compatibility tenant</span>
                </div>
                <p className={styles.compatibilityCopy}>
                  Uses the same visible organizer, reviewer, CFP, and sealed-release mechanisms—no
                  password or arbitrary credential entry.
                </p>
                <div className={styles.compatibilityFacts}>
                  <div className={styles.compatibilityFact}>
                    <span className={styles.roleTag}>Organizer</span>
                    <h3>{DEVFLOW_EVALUATOR_PROFILE.organizer.fullName}</h3>
                    <Link className={styles.inlineLink} href="#workspace-entry">
                      Use the DevFlow organizer entry above
                    </Link>
                  </div>
                  <div className={styles.compatibilityFact}>
                    <span className={styles.roleTag}>Applicant / speaker</span>
                    <h3>{DEVFLOW_EVALUATOR_PROFILE.people.map((person) => person.fullName).join(" · ")}</h3>
                    <Link
                      className={styles.inlineLink}
                      href={`/cfp/${EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG}/${EVALUATOR_COMPATIBILITY_CALL_SLUG}`}
                    >
                      Open DevFlow Conf 2027 CFP
                    </Link>
                  </div>
                  <div className={styles.compatibilityFact}>
                    <span className={styles.roleTag}>Reviewer</span>
                    <h3>{DEVFLOW_EVALUATOR_PROFILE.reviewer.fullName}</h3>
                    <Link className={styles.inlineLink} href="#reviewer-entry">
                      Use the reviewer entry here
                    </Link>
                  </div>
                  <div className={styles.compatibilityFact}>
                    <span className={styles.roleTag}>Attendee</span>
                    <h3>{DEVFLOW_EVALUATOR_PROFILE.attendee.label}</h3>
                    <p>Uses the validated shared sealed release when one is current.</p>
                  </div>
                </div>
              </div>
            </aside>

          </div>
        </div>

        <aside
          className={styles.heroRail}
          aria-label="Sympose operating model and publication"
          data-testid="hero-release-rail"
        >
            <section className={styles.objectChain} aria-labelledby="object-chain-title">
              <p className={styles.sectionKicker}>The operating model</p>
              <h2 id="object-chain-title">People → Evidence → Commitments → Publication</h2>
              <ol className={styles.chainList}>
                <li>
                  <span className={styles.chainIndex} aria-hidden="true">01</span>
                  <span>
                    <strong>People</strong>
                    <small>Canonical identities and relationships</small>
                  </span>
                </li>
                <li>
                  <span className={styles.chainIndex} aria-hidden="true">02</span>
                  <span>
                    <strong>Evidence</strong>
                    <small>Source-backed context for decisions</small>
                  </span>
                </li>
                <li>
                  <span className={styles.chainIndex} aria-hidden="true">03</span>
                  <span>
                    <strong>Commitments</strong>
                    <small>Confirmed roles and responses</small>
                  </span>
                </li>
                <li>
                  <span className={styles.chainIndex} aria-hidden="true">04</span>
                  <span>
                    <strong>Publication</strong>
                    <small>Audience-safe output from sealed truth</small>
                  </span>
                </li>
              </ol>
            </section>

            <section className={styles.releaseCard} aria-labelledby="hero-release-title">
              <div className={styles.releaseCardHeader}>
                <p className={styles.sectionKicker}>Attendee-facing projection</p>
                <span className={`${styles.releaseState} ${attendeeRelease ? styles.releaseStateReady : styles.releaseStateUnavailable}`}>
                  {attendeeRelease ? "Validated" : "Unavailable"}
                </span>
              </div>
              <h2 id="hero-release-title">{attendeeRelease ? "Sealed public release" : "Attendee agenda unavailable"}</h2>
              {attendeeRelease ? (
                <>
                  <p className={styles.releaseEvent}>{attendeeRelease.projection.event.name}</p>
                  <dl className={styles.releaseFacts}>
                    <div>
                      <dt>Release</dt>
                      <dd>#{attendeeRelease.binding.widget.release.releaseNumber}</dd>
                    </div>
                    <div>
                      <dt>People shown</dt>
                      <dd>{attendeeRelease.projection.speakers.length}</dd>
                    </div>
                    <div>
                      <dt>Sessions</dt>
                      <dd>{attendeeRelease.projection.sessions.length}</dd>
                    </div>
                    <div>
                      <dt>Sealed</dt>
                      <dd>
                        <time
                          data-testid="landing-sealed-at"
                          dateTime={attendeeRelease.projection.release.sealedAt}
                        >
                          {formatLandingEventTime(
                            attendeeRelease.projection.release.sealedAt,
                            attendeeRelease.projection.event.timezone,
                          )}
                        </time>
                      </dd>
                    </div>
                  </dl>
                </>
              ) : null}
              <div
                className={styles.releaseStatusPanel}
                id="attendee-agenda-status"
                data-testid="attendee-agenda-status"
                role="status"
              >
                <strong>{attendeeRelease ? "Attendee agenda available" : "Attendee agenda unavailable"}</strong>
                {attendeeRelease ? (
                  <p>
                    A current sealed public release passed validation.{" "}
                    <Link href={attendeeAgendaHref}>Open validated release agenda.</Link>
                  </p>
                ) : (
                  <p>
                    No current sealed public release can be verified for this fixture. Validate it
                    from the organizer publication surface first.
                  </p>
                )}
              </div>
            </section>
        </aside>

        <footer className={styles.footer}>
          <span className={styles.footerRule} aria-hidden="true" />
          <p>
            <strong>Fixture data only.</strong> No real participant or organizer data is used.
          </p>
        </footer>
      </div>
    </main>
  );
}
