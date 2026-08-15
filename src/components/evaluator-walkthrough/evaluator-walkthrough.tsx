import Link from "next/link";

import {
  UNAVAILABLE_EVALUATOR_BUILD_IDENTITY,
  type EvaluatorBuildIdentity,
} from "./build-identity";
import {
  createEvaluatorWalkthroughContent,
  requiredCriterionCount,
  type WalkthroughRouteLink,
} from "./route-map";
import { DEVFLOW_EVALUATOR_PROFILE } from "@/server/evaluator-demo";
import styles from "./evaluator-walkthrough.module.css";

function RouteLink({ route, compact = false }: { readonly route: WalkthroughRouteLink; readonly compact?: boolean }) {
  return (
    <Link className={compact ? styles.routeLinkCompact : styles.routeLink} href={route.href}>
      <span>{route.label}</span>
      <span className={styles.routeArrow} aria-hidden="true">↗</span>
    </Link>
  );
}
function SectionIntro({
  eyebrow,
  title,
  description,
  id,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly id: string;
}) {
  return (
    <header className={styles.sectionIntro}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 id={id}>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function PersonaCard({
  name,
  role,
  detail,
  action,
}: {
  readonly name: string;
  readonly role: string;
  readonly detail: string;
  readonly action: string;
}) {
  return (
    <article className={styles.personaCard}>
      <div className={styles.personaCardTopline}>
        <span className={styles.syntheticTag}>Synthetic only</span>
        <span className={styles.personaRole}>{role}</span>
      </div>
      <h3>{name}</h3>
      <p>{detail}</p>
      <p className={styles.personaAction}>{action}</p>
    </article>
  );
}

const guideSections = [
  { id: "proof-capsule", label: "Proof" },
  { id: "personas", label: "Actors" },
  { id: "entry-sessions", label: "Sessions" },
  { id: "devflow-compatibility", label: "DevFlow" },
  { id: "public-links", label: "Public" },
  { id: "organizer-path", label: "Handoff" },
  { id: "public-widgets", label: "Widgets" },
  { id: "evaluation-areas", label: "Checks" },
  { id: "limitations", label: "Boundaries" },
] as const;

export function EvaluatorWalkthrough({
  buildIdentity = UNAVAILABLE_EVALUATOR_BUILD_IDENTITY,
  releaseReference,
}: {
  readonly buildIdentity?: EvaluatorBuildIdentity;
  readonly releaseReference: string | null;
}) {
  const {
    routes,
    devflowGoldenPath,
    organizerJourney,
    publicWidgetSurfaces,
    publisherTool,
    evaluationAreas,
    publicReleaseAvailable,
  } = createEvaluatorWalkthroughContent(releaseReference);
  return (
    <main className={styles.page} data-testid="evaluator-walkthrough">
      <div className={styles.ambientGlow} aria-hidden="true" />
      <div className={styles.frame}>
        <header className={styles.topbar}>
          <Link className={styles.brand} href={routes.root}>
            <span className={styles.brandMark} aria-hidden="true">S</span>
            <span>
              <strong>Sympose</strong>
              <small>Evaluator walkthrough</small>
            </span>
          </Link>
          <div className={styles.topbarMeta}>
            <span className={styles.readOnlyPill}>Public · read-only</span>
            <Link className={styles.topbarLink} href={routes.root}>
              Root entry <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </header>

        <div className={styles.content}>
          <section className={styles.hero} aria-labelledby="walkthrough-title">
            <div className={styles.heroCopy}>
              <p className={styles.heroKicker}>A route map for evidence-led evaluation</p>
              <h1 id="walkthrough-title">See the whole Sympose loop before you score it.</h1>
              <p className={styles.heroLede}>
                Start with the synthetic personas, follow the signed-in organizer handoff, then inspect every public
                surface from one calm, linked guide. Nothing here requires a guessed ID or an internal tool.
              </p>
              <div className={styles.heroActions}>
                <Link className={styles.primaryButton} href={routes.root}>
                  Start at the root
                  <span aria-hidden="true">→</span>
                </Link>
                <a className={styles.secondaryButton} href="#evaluation-areas">
                  Browse evaluation areas
                </a>
              </div>
              <p className={styles.roleTrail} aria-label="Role transitions">
                Organizer <span aria-hidden="true">→</span> reviewer <span aria-hidden="true">→</span> applicant
                <span aria-hidden="true">→</span> speaker <span aria-hidden="true">→</span> attendee
              </p>
            </div>
            <aside className={styles.heroIndex} aria-label="Walkthrough scope">
              <div className={styles.heroIndexNumber}>{requiredCriterionCount}</div>
              <div className={styles.heroIndexLabel}>required matrix checks</div>
              <div className={styles.heroIndexRule} />
              <div className={styles.heroIndexMeta}>
                <span>6</span>
                <span>areas</span>
              </div>
              <div className={styles.heroIndexMeta}>
                <span>5</span>
                <span>public widget surfaces</span>
              </div>
            </aside>
          </section>

          <aside className={styles.matrixNote} role="note" aria-label="How to use this guide">
            <div className={styles.noteIcon} aria-hidden="true">i</div>
            <div>
              <strong>Use this as a route and evidence checklist, not a pre-score.</strong>
              <p>
                The repository-owned matrix currently marks all {requiredCriterionCount} required criteria as pending.
                Existing links and fixture states are surfaced here so an evaluator can test what is visible and record
                an honest absence where a capability is not implemented.
              </p>
            </div>
          </aside>

          <aside
            className={styles.matrixNote}
            data-testid="evaluator-build-identity"
            role="status"
            aria-label="Evaluator runtime and build identity"
          >
            <div className={styles.noteIcon} aria-hidden="true">#</div>
            <div>
              <strong>Runtime/build identity</strong>
              <p>
                {buildIdentity.status === "bound"
                  ? "This server-rendered walkthrough received a validated full candidate SHA. Confirm the same value at /health before treating the run as exact-candidate evidence."
                  : "Unavailable: no validated full candidate SHA was supplied to this server-rendered page. The route remains reachable, but it is not exact-candidate evidence."}
              </p>
              <p className={styles.identityMeta}>
                <span>Displayed identity</span>
                <code data-testid="evaluator-build-sha">{buildIdentity.value}</code>
                <Link className={styles.inlineLink} href="/health">Open /health</Link>
                <Link className={styles.inlineLink} data-testid="walkthrough-return-home" href={routes.root}>
                  Return to root entry
                </Link>
              </p>
            </div>
          </aside>

          <nav className={styles.progressRail} aria-label="Walkthrough progress" data-testid="walkthrough-progress">
            <div className={styles.progressRailHeading}>
              <span className={styles.progressRailLabel}>Guide progress</span>
              <span>{guideSections.length} linked checkpoints</span>
            </div>
            <ol>
              {guideSections.map((section, index) => (
                <li key={section.id}>
                  <a href={`#${section.id}`}>
                    <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                    {section.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <section className={styles.section} id="proof-capsule" aria-labelledby="proof-capsule-title">
            <SectionIntro
              eyebrow="00 · exact proof capsule"
              id="proof-capsule-title"
              title="Verify the candidate, then return to the evaluator root"
              description="These commands bind a local evaluator run to committed source. They do not create a session, mint a token, or grant an evaluator authority."
            />
            <div className={styles.entryGrid} data-testid="evaluator-proof-capsule">
              <article className={styles.entryCard}>
                <div className={styles.entryNumber}>A</div>
                <div>
                  <div className={styles.cardEyebrow}>Deterministic checks</div>
                  <h3>Use the exact source and health record</h3>
                  <ol className={styles.instructionList}>
                    <li>Print <code>git rev-parse HEAD</code> and retain all 40 characters.</li>
                    <li>Run <code>git diff --check</code> and the focused proof test.</li>
                    <li>Run <code>pnpm exec tsc --noEmit --incremental false</code>.</li>
                    <li>Start with <code>SYMPOSE_BUILD_SHA=&lt;full-40-character-HEAD&gt; pnpm evaluator:release:start</code>.</li>
                    <li>Confirm <Link href="/health">/health</Link> returns the same lowercase SHA and <code>synthetic-evaluator</code>.</li>
                  </ol>
                </div>
              </article>
              <article className={styles.entryCard}>
                <div className={styles.entryNumber}>B</div>
                <div>
                  <div className={styles.cardEyebrow}>Returnability</div>
                  <h3>Every role returns through the visible root</h3>
                  <p>
                    Use the root entry to choose the synthetic organizer or reviewer session, and use fresh
                    contexts for role changes. Public CFP, speaker, attendee, and widget routes remain read-only
                    handoffs; the walkthrough never supplies credentials or bypasses a protected route.
                  </p>
                  <Link className={styles.primaryButton} href={routes.root}>
                    Return to root entry <span aria-hidden="true">↗</span>
                  </Link>
                </div>
              </article>
            </div>
          </section>

          <section className={styles.section} id="personas" aria-labelledby="personas-title">
            <SectionIntro
              eyebrow="01 · start with the actors"
              id="personas-title"
              title="Every named person is synthetic"
              description="The Acme journey is seeded for local evaluation. Use fresh browser contexts when comparing organizer, reviewer, speaker, and attendee views."
            />
            <div className={styles.personaGrid}>
              <PersonaCard
                name="Acme Organizer"
                role="Organizer session"
                detail="The seeded organizer choice is shown at the root as Acme Organizer · organizer@acme.example. It opens the Acme Events workspace."
                action="Use for the event-scoped CFP → review → speaker operations → program → publication path."
              />
              <PersonaCard
                name="Acme Demo Reviewer"
                role="Reviewer session"
                detail="The root's evaluator persona section exposes the seeded reviewer entry. It opens a reviewer-capability queue, separate from organizer navigation."
                action="Use a fresh context, then inspect the one assigned synthetic proposal."
              />
              <PersonaCard
                name="Mina · Noor · Iris"
                role="Applicant / speaker fixtures"
                detail="Mina Park is the accepted speaker fixture; Noor Haddad has a submitted workshop; Iris Cole has a draft. These are synthetic proposal states."
                action="Use the Acme CFP for these proposal states, then continue Mina’s accepted proposal through the primary speaker preview and public release."
              />
              <PersonaCard
                name="Anonymous attendee"
                role="Public viewer"
                detail="The attendee and widget routes require no organizer session. They resolve the current scoped immutable release for the Acme event."
                action="Use a non-admin context for public surface and source-consistency checks."
              />
            </div>
          </section>

          <section className={styles.section} id="entry-sessions" aria-labelledby="entry-title">
            <SectionIntro
              eyebrow="02 · session entry"
              id="entry-title"
              title="Enter organizer and reviewer sessions from the root"
              description="The root is the only session entry point you need. Do not paste cookies, infer tokens, or jump to an internal service."
            />
            <div className={styles.entryGrid}>
              <article className={styles.entryCard}>
                <div className={styles.entryNumber}>A</div>
                <div>
                  <div className={styles.cardEyebrow}>Organizer</div>
                  <h3>Open the Acme organizer console</h3>
                  <ol className={styles.instructionList}>
                    <li><Link href={routes.root}>Open the public root</Link>.</li>
                    <li>Select <strong>Acme Organizer</strong> in the organizer choices.</li>
                    <li>Choose <strong>Sign in to workspace</strong>; the root redirects to the Acme dashboard.</li>
                  </ol>
                  <Link className={styles.inlineLink} href={routes.organizerDashboard}>
                    Organizer dashboard route <span aria-hidden="true">↗</span>
                  </Link>
                </div>
              </article>
              <article className={styles.entryCard}>
                <div className={styles.entryNumber}>B</div>
                <div>
                  <div className={styles.cardEyebrow}>Reviewer</div>
                  <h3>Open the isolated reviewer queue</h3>
                  <ol className={styles.instructionList}>
                    <li><Link href={routes.root}>Open the public root</Link> in a fresh context.</li>
                    <li>In <strong>Evaluator persona entry points</strong>, keep <strong>Acme Demo Reviewer</strong> selected.</li>
                    <li>Choose <strong>Enter synthetic reviewer queue</strong>; do not use organizer login.</li>
                  </ol>
                  <Link className={styles.inlineLink} href={routes.reviewerQueue}>
                    Reviewer queue route <span aria-hidden="true">↗</span>
                  </Link>
                </div>
              </article>
            </div>
          </section>

          <section className={styles.section} id="devflow-compatibility" aria-labelledby="devflow-title">
            <SectionIntro
              eyebrow="03 · compatibility reference"
              id="devflow-title"
              title="Verify DevFlow without interrupting the primary journey"
              description={`The ${DEVFLOW_EVALUATOR_PROFILE.eventName} tenant remains available for pinned compatibility checks. It is intentionally secondary to the complete Acme walkthrough, and no link creates authority by itself.`}
            />
            <div className={styles.entryGrid} data-testid="devflow-walkthrough-profile">
              <article className={styles.entryCard}>
                <div className={styles.entryNumber}>A</div>
                <div>
                  <div className={styles.cardEyebrow}>Persisted compatibility identities</div>
                  <h3>{DEVFLOW_EVALUATOR_PROFILE.organizer.fullName} · {DEVFLOW_EVALUATOR_PROFILE.reviewer.fullName}</h3>
                  <p>
                    Priya Raman and Marcus Okafor are canonical people with real local CFP applicant
                    sessions. The organizer and reviewer entries use the existing server session and
                    capability checks; there is no password or arbitrary-credential path.
                  </p>
                </div>
              </article>
              <article className={styles.entryCard}>
                <div className={styles.entryNumber}>B</div>
                <div>
                  <div className={styles.cardEyebrow}>Shared-surface boundary</div>
                  <h3>{DEVFLOW_EVALUATOR_PROFILE.attendee.label}</h3>
                  <p>
                    The secondary compatibility entry opens Priya Raman’s canonical DevFlow
                    assignment and durable tasks. The primary speaker and attendee path follows Mina
                    Park inside Acme; neither event is relabeled as the other.
                  </p>
                </div>
              </article>
            </div>
            <ol className={styles.journey} data-testid="devflow-golden-path">
              {devflowGoldenPath.map((step, index) => (
                <li className={styles.journeyItem} key={step.href}>
                  <div className={styles.journeyRail} aria-hidden="true">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                  </div>
                  <div className={styles.journeyBody}>
                    <div className={styles.journeyHeading}>
                      <h3><Link href={step.href}>{step.label}</Link></h3>
                      <code>{step.href}</code>
                    </div>
                    <p>{step.note}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className={styles.section} id="public-links" aria-labelledby="public-links-title">
            <SectionIntro
              eyebrow="04 · public handoffs"
              id="public-links-title"
              title="Three public anchors, already linked"
              description="These are the public checkpoints most likely to be missed when an evaluator starts inside the organizer console."
            />
            <div className={styles.publicAnchorGrid}>
              <article className={styles.publicAnchorCard}>
                <div className={`${styles.anchorIcon} ${styles.anchorIconCyan}`} aria-hidden="true">01</div>
                <div>
                  <span className={styles.cardEyebrow}>Call for papers</span>
                  <h3>Stagecraft 2026 CFP</h3>
                  <p>Open the logged-out form, disclosure, deadline, choices, and conditional workshop-plan field.</p>
                  <RouteLink route={{ label: "Open public CFP", href: routes.publicCfp, note: "" }} />
                </div>
              </article>
              <article className={styles.publicAnchorCard}>
                <div className={`${styles.anchorIcon} ${styles.anchorIconViolet}`} aria-hidden="true">02</div>
                <div>
                  <span className={styles.cardEyebrow}>Speaker portal</span>
                  <h3>Mina Park’s accepted-session workspace</h3>
                  <p>Continue the accepted Acme proposal into Mina’s exact offer terms, durable tasks, content versions, and local PNG/PDF artifact handling.</p>
                  <RouteLink route={{ label: "Open scoped speaker portal", href: routes.speakerCheckpoint, note: "" }} />
                </div>
              </article>
              <article className={styles.publicAnchorCard}>
                <div className={`${styles.anchorIcon} ${styles.anchorIconAmber}`} aria-hidden="true">03</div>
                <div>
                  <span className={styles.cardEyebrow}>Attendee result</span>
                  <h3>Sympose Summit 2026 agenda</h3>
                  <p>See the public agenda handoff after publication, without entering the organizer workspace.</p>
                  <RouteLink route={{ label: "Open attendee agenda", href: routes.attendeeAgenda, note: "" }} />
                </div>
              </article>
            </div>
          </section>

          <section className={styles.section} id="organizer-path" aria-labelledby="organizer-path-title">
            <SectionIntro
              eyebrow="05 · the golden handoff"
              id="organizer-path-title"
              title="Signed-in organizer path"
              description="After entering Acme from the root, walk this order. The first six links require the organizer session; the final link is public."
            />
            <ol className={styles.journey}>
              {organizerJourney.map((step, index) => (
                <li className={styles.journeyItem} key={step.href}>
                  <div className={styles.journeyRail} aria-hidden="true">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                  </div>
                  <div className={styles.journeyBody}>
                    <div className={styles.journeyHeading}>
                      <h3><Link href={step.href}>{step.label}</Link></h3>
                      <code>{step.href}</code>
                    </div>
                    <p>{step.note}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className={styles.section} id="public-widgets" aria-labelledby="public-widgets-title">
            <SectionIntro
              eyebrow="06 · non-admin surfaces"
              id="public-widgets-title"
              title="Open all five public widget surfaces"
              description="Sessions, speakers, gallery, agenda, and itinerary are each bound to the validated opaque reference of the current sealed release. Publisher configuration remains a separate tool."
            />
            {publicReleaseAvailable ? (
              <>
                <div className={styles.widgetGrid} data-testid="walkthrough-public-widget-links">
                  {publicWidgetSurfaces.map((surface, index) => (
                    <article className={styles.widgetCard} key={surface.href}>
                      <div className={styles.widgetIndex}>{String(index + 1).padStart(2, "0")}</div>
                      <div className={styles.widgetCardContent}>
                        <h3><Link href={surface.href}>{surface.label}</Link></h3>
                        <p>{surface.note}</p>
                        <code>{surface.href}</code>
                      </div>
                      <span className={styles.surfaceBadge}>Public</span>
                    </article>
                  ))}
                </div>
                {publisherTool ? (
                  <aside className={styles.matrixNote} data-testid="walkthrough-publisher-tool">
                    <div className={styles.noteIcon} aria-hidden="true">↗</div>
                    <div>
                      <strong>Separate publisher tool</strong>
                      <p>{publisherTool.note}</p>
                      <RouteLink compact route={publisherTool} />
                    </div>
                  </aside>
                ) : null}
              </>
            ) : (
              <aside className={styles.matrixNote} data-testid="walkthrough-public-widget-unavailable" role="status">
                <div className={styles.noteIcon} aria-hidden="true">i</div>
                <div>
                  <strong>Public widgets unavailable</strong>
                  <p>A validated current sealed release is not available, so this walkthrough does not manufacture fallback links or content.</p>
                </div>
              </aside>
            )}
          </section>

          <section className={styles.section} id="evaluation-areas" aria-labelledby="evaluation-areas-title">
            <SectionIntro
              eyebrow="07 · weighted area map"
              id="evaluation-areas-title"
              title="Every required area has a route and a checkpoint"
              description="Use the route links first, then the concise evidence prompts. Criterion IDs are included so no weighted area depends on guesswork."
            />
            <div className={styles.areaGrid}>
              {evaluationAreas.map((area, index) => (
                <article className={styles.areaCard} id={area.id} key={area.id}>
                  <header className={styles.areaHeader}>
                    <div className={styles.areaTitleBlock}>
                      <span className={styles.areaNumber}>{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <p className={styles.cardEyebrow}>Required area · {area.count} checks</p>
                        <h3>{area.title}</h3>
                      </div>
                    </div>
                    <span className={styles.pendingBadge}>Pending in matrix</span>
                  </header>
                  <div className={styles.areaRoutes} aria-label={`${area.title} route links`}>
                    {area.routeLinks.map((route) => <RouteLink compact key={`${route.href}:${route.label}`} route={route} />)}
                  </div>
                  <div className={styles.checkpointBlock}>
                    <h4>What to test</h4>
                    <ul>
                      {area.checkpoints.map((checkpoint) => <li key={checkpoint}>{checkpoint}</li>)}
                    </ul>
                  </div>
                  <details className={styles.criteriaDetails}>
                    <summary>Show criterion IDs <span>· {area.criteria.length}</span></summary>
                    <div className={styles.criteriaList} aria-label={`${area.title} criterion IDs`}>
                      {area.criteria.map((criterion) => <code key={criterion}>{criterion}</code>)}
                    </div>
                  </details>
                </article>
              ))}
            </div>
          </section>

          <section className={styles.section} id="limitations" aria-labelledby="limitations-title">
            <SectionIntro
              eyebrow="08 · evidence boundaries"
              id="limitations-title"
              title="What is local, simulated, or intentionally absent"
              description="These limitations are part of the evaluator contract. Keep them attached to your evidence instead of filling gaps with assumptions."
            />
            <div className={styles.limitationsGrid}>
              <article className={styles.limitationCard}>
                <span className={styles.limitationLabel}>Seeded journey</span>
                <h3>Acme is preloaded for navigation</h3>
                <p>It contains one public CFP, three proposal states, one reviewer assignment, a sealed rubric/blind artifact, one accepted plan commitment, and a publication release. That fixture does not pre-prove every matrix criterion.</p>
              </article>
              <article className={styles.limitationCard}>
                <span className={styles.limitationLabel}>Speaker + content</span>
                <h3>Durable local workflow, bounded local artifacts</h3>
                <p>Speaker tasks, profile and text versions, exact reviews, and artifact metadata persist in scoped local SQLite. HEADSHOT and SLIDES uploads store bounded PNG/PDF bytes in authenticated local filesystem storage. The metadata CSV intentionally omits file bytes; no object-storage provider, malware scanning, SMTP, or provider delivery is claimed.</p>
              </article>
              <article className={styles.limitationCard}>
                <span className={styles.limitationLabel}>Agenda + publication</span>
                <h3>Durable local authority, no provider backend</h3>
                <p>Program schedule drafts, exact organizer approvals, and immutable publication releases persist in local SQLite. Public agendas and widgets resolve only a validated scoped sealed release. This local evaluator setup does not claim shared multi-instance infrastructure or a provider backend.</p>
              </article>
              <article className={styles.limitationCard}>
                <span className={styles.limitationLabel}>Review + AI</span>
                <h3>No AI result is implied</h3>
                <p>The seeded review journey makes no AI-review claim. Record a no-AI observation unless a visible route separately exposes an AI score, rationale, and human override.</p>
              </article>
            </div>
          </section>

          <footer className={styles.footer}>
            <span>Sympose evaluator walkthrough</span>
            <span>·</span>
            <span>Synthetic fixtures only</span>
            <span>·</span>
            <Link href={routes.root}>Return to root entry</Link>
          </footer>
        </div>
      </div>
    </main>
  );
}
