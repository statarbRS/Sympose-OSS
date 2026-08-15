"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useActionState } from "react";

import type { SealPublicationActionState } from "@/app/w/[workspace]/events/[eventId]/publication/actions";
import { ReleaseTwinProof } from "@/components/operator-proof/operator-proof-experience";
import type { OperatorProofExperienceProjection } from "@/server/services/operator-proof";
import type {
  PublicationConsoleAudienceMatrix,
  PublicationConsoleRelease,
} from "./publication-console-model";
import type { PublicationAudienceMatrixStatus } from "@/server/services/publication-audience";

import styles from "./publication-console.module.css";

type SealAction = (
  previousState: SealPublicationActionState,
  formData: FormData,
) => Promise<SealPublicationActionState>;

type AudienceAction = (
  formData: FormData,
) => Promise<void>;

const INITIAL_SEAL_STATE: SealPublicationActionState = {
  ok: true,
  code: "IDLE",
  message: "",
  release: null,
};

export type PublicationCeremonyPhase = "READY" | "SEALING" | "SEALED";

export function publicationCeremonyPhase(
  pending: boolean,
  state: SealPublicationActionState,
): PublicationCeremonyPhase {
  if (pending) return "SEALING";
  if (state.ok && state.release !== null) return "SEALED";
  return "READY";
}

interface PublicationEvent {
  readonly id: string;
}

const RICH_REDACTIONS = [
  "Email addresses",
  "Speaker organization and biography",
  "Plan rationale and internal scores",
] as const;

const LEGACY_REDACTIONS = [
  "Email addresses",
  "Room and venue",
  "Track and format",
  "Session abstract",
  "Speaker organization and biography",
  "Plan rationale and internal scores",
] as const;

export function formatEventTime(value: string, timezone: string): string {
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

function matrixStatusLabel(status: PublicationAudienceMatrixStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function AudienceCommandForm({
  action,
  label,
  children,
}: {
  readonly action: AudienceAction;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <form action={action} className={styles.audienceCommandForm}>
      {children}
      <button className={styles.button} type="submit">{label}</button>
    </form>
  );
}

export function CompletedPublicationCeremony({
  release,
  message,
  hadBaseline,
  reviewHref,
}: {
  readonly release: NonNullable<SealPublicationActionState["release"]>;
  readonly message: string;
  readonly hadBaseline: boolean;
  readonly reviewHref: string;
}) {
  return (
    <div className={styles.stack} data-testid="publication-console" data-release-state="SEALED">
      <section className={`${styles.section} ${styles.handoffSection} ${styles.ceremonyOnly}`} aria-labelledby="publication-executed-title">
        <p className={styles.eyebrow}>Release ceremony · completed</p>
        <h1 id="publication-executed-title">
          {release.created
            ? hadBaseline ? "Immutable successor release sealed" : "First immutable release sealed"
            : "Existing release verified"}
        </h1>
        <p className={styles.notice} role="status">{message}</p>
        <dl className={styles.releaseMeta} data-testid="publication-seal-receipt">
          <div><dt>Release ID</dt><dd><code>{release.releaseId}</code></dd></div>
          <div><dt>Content fingerprint</dt><dd><code>{release.fingerprint}</code></dd></div>
          <div><dt>Materialized agendas</dt><dd>{release.agendaCount}</dd></div>
          <div><dt>Execution</dt><dd>{release.created ? "New immutable release" : "Idempotent replay"}</dd></div>
        </dl>
        <a className={`${styles.button} ${styles.buttonPrimary}`} href={reviewHref}>
          Review current release
        </a>
      </section>
    </div>
  );
}

export function PublicationConsole({
  workspaceSlug,
  event,
  currentRelease,
  action,
  audienceMatrix = null,
  audienceAction,
  operatorProof,
}: {
  readonly workspaceSlug: string;
  readonly event: PublicationEvent;
  readonly currentRelease: PublicationConsoleRelease | null;
  readonly action: SealAction;
  readonly audienceMatrix?: PublicationConsoleAudienceMatrix | null;
  readonly audienceAction?: AudienceAction;
  readonly operatorProof?: OperatorProofExperienceProjection;
}) {
  const [sealState, sealFormAction, sealPending] = useActionState(action, INITIAL_SEAL_STATE);
  // A prior immutable release is baseline evidence for this attempt, never the success receipt.
  // Only the completed server action moves the ceremony itself into the terminal SEALED view.
  const ceremonyPhase = publicationCeremonyPhase(sealPending, sealState);
  if (ceremonyPhase === "SEALING") {
    return (
      <div className={styles.stack} data-testid="publication-console" data-release-state="SEALING">
        <section className={`${styles.section} ${styles.handoffSection} ${styles.ceremonyOnly}`} aria-labelledby="publication-sealing-title">
          <p className={styles.eyebrow}>Release ceremony · executing</p>
          <h1 id="publication-sealing-title">Sealing the durable release…</h1>
          <p className={styles.sectionIntro} role="status" aria-live="polite">
            The server is revalidating the exact approved plan, schedule approval, content versions,
            artifacts, accepted terms, and audience policy. No success receipt exists until the
            transaction completes.
          </p>
        </section>
      </div>
    );
  }
  if (ceremonyPhase === "SEALED" && sealState.ok && sealState.release) {
    return <CompletedPublicationCeremony
      release={sealState.release}
      message={sealState.message}
      hadBaseline={currentRelease !== null}
      reviewHref={`/w/${encodeURIComponent(workspaceSlug)}/events/${encodeURIComponent(event.id)}/publication`}
    />;
  }
  const content = currentRelease?.content ?? null;
  const previewTimezone = content?.eventTimezone ?? "UTC";
  const publicLink = currentRelease?.publicAgendaPath ?? null;
  const redactedFields = content?.hasSchedule ? RICH_REDACTIONS : LEGACY_REDACTIONS;
  const includedPeople = content?.agendaCount ?? null;
  const agendaItems = content?.agendaItemCount ?? null;
  const excludedAcceptedPeople = content
    ? Math.max(0, content.acceptedPersonCount - content.agendaCount)
    : null;
  const items = content?.previewItems ?? [];
  const visibleItems = items.slice(0, 4);
  const catalogedCurrentRelease = audienceMatrix && currentRelease
    ? audienceMatrix.releases.find((release) =>
        release.releaseId === currentRelease.releaseId &&
        release.releaseFingerprint === currentRelease.fingerprint)
      ?? null
    : null;
  const publicationOutcome = operatorProof?.readiness.outcomes.find((outcome) => outcome.outcome === "PUBLICATION") ?? null;
  const currentAudienceRows = audienceMatrix?.rows.filter((row) => row.status === "CURRENT") ?? [];
  const workflowSteps = [
    {
      number: 1,
      title: "Prove source authority",
      status: publicationOutcome?.status ?? "UNAVAILABLE",
      detail: publicationOutcome?.status === "READY"
        ? "Exact plan, commitment, schedule, and sealed-release dependencies are proven."
        : publicationOutcome?.blockers[0]?.message ?? "Exact publication evidence is unavailable.",
    },
    {
      number: 2,
      title: "Review audience impact",
      status: currentRelease ? "READY" : "UNAVAILABLE",
      detail: currentRelease
        ? `${includedPeople ?? 0} included agendas, ${excludedAcceptedPeople ?? 0} excluded accepted people, and ${redactedFields.length} redacted field groups.`
        : "A validated sealed projection is required before audience impact can be counted.",
    },
    {
      number: 3,
      title: "Catalog exact version",
      status: catalogedCurrentRelease ? "READY" : "UNAVAILABLE",
      detail: catalogedCurrentRelease
        ? `Release version ${catalogedCurrentRelease.versionNumber} is cataloged without changing the sealed release.`
        : "The validated current release has no exact immutable catalog version yet.",
    },
    {
      number: 4,
      title: "Bind policy to audience",
      status: currentAudienceRows.length > 0 ? "READY" : "UNAVAILABLE",
      detail: currentAudienceRows.length > 0
        ? `${currentAudienceRows.length} exact current audience binding${currentAudienceRows.length === 1 ? "" : "s"} carr${currentAudienceRows.length === 1 ? "ies" : "y"} receipt authority.`
        : audienceMatrix
          ? "No channel and policy receipt exactly binds the current release."
          : "Audience matrix evidence is unavailable for this view.",
    },
    {
      number: 5,
      title: "Resolve the public pointer",
      status: currentRelease ? "READY" : "UNAVAILABLE",
      detail: currentRelease
        ? "The durable pointer resolves to this exact validated immutable release."
        : "The durable pointer does not resolve to a validated current release.",
    },
  ] as const;
  return (
    <div className={styles.stack} data-testid="publication-console" data-release-state={ceremonyPhase}>
      <section className={styles.releaseHero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Publication channel · durable public release</p>
          <h1>{currentRelease ? "Current durable event projection" : "Seal the approved event projection"}</h1>
          <p className={styles.muted}>
            Review the exact audience surface first, then hand the current approved plan and
            accepted commitments to the authenticated publication service.
          </p>
          <div className={styles.linkRow}>
            {publicLink ? (
              <Link className={`${styles.button} ${styles.buttonPrimary}`} href={publicLink}>
                Open current public agenda
              </Link>
            ) : null}
            <Link
              className={styles.button}
              href={`/w/${encodeURIComponent(workspaceSlug)}/events/${encodeURIComponent(event.id)}/program`}
            >
              Back to program
            </Link>
          </div>
        </div>
        <div className={styles.currentPointer} data-testid="durable-current-release">
          <span>Durable current pointer</span>
          <strong>{currentRelease ? "Sealed" : "Not sealed"}</strong>
          <code>{currentRelease?.releaseId ?? "No current release"}</code>
        </div>
      </section>

      <section className={`${styles.section} ${styles.previewSection}`} aria-labelledby="audience-preview-title">
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.eyebrow}>Audience preview</p>
            <h2 id="audience-preview-title">What the public audience can see now</h2>
          </div>
          <span className={styles.stateChip}>{currentRelease ? "Current sealed release" : "No sealed preview"}</span>
        </div>
        <p className={styles.sectionIntro}>
          This preview reads only the validated sealed projection. It does not reconstruct output
          from draft planning rows or expose organizer-only rationale.
        </p>

        <dl className={styles.previewSummary} data-testid="publication-audience-counts">
          <div>
            <dt>Included agendas</dt>
            <dd>{includedPeople ?? "—"}<small>One per included accepted person</small></dd>
          </div>
          <div>
            <dt>Included agenda items</dt>
            <dd>{agendaItems ?? "—"}<small>Immutable release items</small></dd>
          </div>
          <div>
            <dt>Excluded accepted people</dt>
            <dd>{excludedAcceptedPeople ?? "—"}<small>Within the sealed accepted set</small></dd>
          </div>
          <div>
            <dt>Redacted field groups</dt>
            <dd>{content ? redactedFields.length : "—"}<small>Omitted from public rendering</small></dd>
          </div>
          <div>
            <dt>Unknown / missing</dt>
            <dd>Not recorded<small>This retained release schema has no unknown-count measurement</small></dd>
          </div>
        </dl>

        {visibleItems.length > 0 ? (
          <div>
            <div className={styles.previewHeading}>
              <h3>Rendered schedule sample</h3>
              <span>Showing {visibleItems.length} of {items.length}</span>
            </div>
            <ol className={styles.previewList}>
              {visibleItems.map((item) => (
                <li key={item.id}>
                  <article>
                    <p className={styles.previewTime}>
                      <time dateTime={item.startsAt}>{formatEventTime(item.startsAt, previewTimezone)}</time>
                      <span aria-hidden="true"> → </span>
                      <time dateTime={item.endsAt}>{formatEventTime(item.endsAt, previewTimezone)}</time>
                    </p>
                    <h3>{item.title}</h3>
                    <p>{item.placement}</p>
                    <span>{item.peopleLabel}</span>
                  </article>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className={styles.emptyPreview}>
            <strong>No audience preview yet</strong>
            <p>A validated sealed release is required before public output is rendered.</p>
          </div>
        )}

        <details className={styles.redactionDisclosure}>
          <summary>{content ? redactedFields.length : "No"} redacted field groups</summary>
          <ul>
            {redactedFields.map((field) => <li key={field}>{field}</li>)}
          </ul>
        </details>
      </section>

      {operatorProof ? <ReleaseTwinProof projection={operatorProof} /> : null}

      <section className={`${styles.section} ${styles.workflowSection}`} aria-labelledby="publication-release-workflow-title">
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.eyebrow}>Organizer release workflow</p>
            <h2 id="publication-release-workflow-title">Preview → version → audience → current pointer</h2>
          </div>
          <span className={styles.stateChip}>Evidence-backed</span>
        </div>
        <p className={styles.sectionIntro}>
          These steps explain the immutable release workflow; they do not replace the server seal,
          policy, binding, or pointer gates. Unavailable steps never inherit authority from a prior version.
        </p>
        <ol className={styles.releaseWorkflow} data-testid="publication-release-workflow">
          {workflowSteps.map((step) => (
            <li key={step.number} data-status={step.status}>
              <span>{step.number}</span>
              <div><h3>{step.title}</h3><p>{step.detail}</p></div>
              <strong>{step.status === "READY" ? "Proven" : step.status === "BLOCKED" ? "Blocked" : "Unavailable"}</strong>
            </li>
          ))}
        </ol>
        <p className={styles.gateNotice}>
          The existing seal action remains authoritative and revalidates exact plan approval,
          accepted offer terms, publication content and artifact approvals, and the durable schedule.
        </p>
      </section>

      <section className={`${styles.section} ${styles.matrixSection}`} aria-labelledby="version-audience-matrix-title">
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.eyebrow}>Audience authority</p>
            <h2 id="version-audience-matrix-title">Version-to-Audience Matrix</h2>
          </div>
          <span className={styles.stateChip}>
            {audienceMatrix ? `${audienceMatrix.rows.length} matrix cells` : "Unavailable"}
          </span>
        </div>
        <p className={styles.sectionIntro}>
          Every cell is derived from immutable catalog, channel, policy, and receipt evidence.
          A newer public release never inherits an older binding, and this matrix never changes or
          gates the established public pointer.
        </p>

        {audienceMatrix && audienceMatrix.rows.length > 0 ? (
          <div className={styles.matrixScroll} data-testid="publication-audience-matrix">
            <table className={styles.matrixTable}>
              <thead>
                <tr>
                  <th scope="col">Release</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Purpose / audience</th>
                  <th scope="col">Policy</th>
                  <th scope="col">Authority</th>
                  <th scope="col">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {audienceMatrix.rows.map((row) => (
                  <tr key={`${row.releaseVersionId}:${row.channelId}`} data-status={row.status}>
                    <td>
                      <strong>v{row.releaseVersion}</strong>
                      <code>{row.releaseId}</code>
                    </td>
                    <td>
                      <strong>{row.channelLabel}</strong>
                      <span>{row.visibility.toLowerCase()}</span>
                    </td>
                    <td>{row.purpose.replaceAll("_", " ")} · {row.audience}</td>
                    <td>{row.policyVersion ? `v${row.policyVersion}` : "No exact policy"}</td>
                    <td>
                      <span className={`${styles.matrixStatus} ${styles[`matrixStatus${row.status}`]}`}>
                        {matrixStatusLabel(row.status)}
                      </span>
                      <small>{row.reason}</small>
                    </td>
                    <td><code>{row.bindingReceiptId ?? "—"}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.emptyPreview} data-testid="publication-audience-matrix-empty">
            <strong>No exact audience matrix rows yet</strong>
            <p>Create an immutable channel and draft policy after a release is cataloged.</p>
          </div>
        )}

        {audienceMatrix && audienceAction ? (
          <div className={styles.authorityControls} data-testid="publication-audience-controls">
            <article className={styles.authorityCard}>
              <div>
                <h3>Create immutable audience channel</h3>
                <p>Purpose, audience, and visibility are fixed on creation. Disable records a receipt; it never edits the channel.</p>
              </div>
              <AudienceCommandForm action={audienceAction} label="Create channel">
                <input type="hidden" name="intent" value="CREATE_CHANNEL" readOnly />
                <input type="hidden" name="idempotencyKey" value={`ui-channel-${audienceMatrix.commandSeed}`} readOnly />
                <label>
                  <span>Channel key</span>
                  <input name="key" defaultValue={`public-agenda-${audienceMatrix.channels.length + 1}`} pattern="[a-z0-9][a-z0-9._-]{0,79}" required />
                </label>
                <label>
                  <span>Label</span>
                  <input name="label" defaultValue="Public agenda" maxLength={120} required />
                </label>
                <label>
                  <span>Purpose</span>
                  <select name="purpose" defaultValue="EVENT_AGENDA">
                    <option value="EVENT_AGENDA">Event agenda</option>
                    <option value="PERSONAL_AGENDA">Personal agenda</option>
                    <option value="SPEAKER_PORTAL">Speaker portal</option>
                    <option value="EMBED">Embed</option>
                  </select>
                </label>
                <label>
                  <span>Audience</span>
                  <select name="audience" defaultValue="PUBLIC">
                    <option value="PUBLIC">Public</option>
                    <option value="ATTENDEE">Attendee</option>
                    <option value="SPEAKER">Speaker</option>
                    <option value="ORGANIZER">Organizer</option>
                  </select>
                </label>
                <label>
                  <span>Visibility</span>
                  <select name="visibility" defaultValue="PUBLIC">
                    <option value="PUBLIC">Public</option>
                    <option value="TOKEN">Scoped token</option>
                    <option value="AUTHENTICATED">Authenticated</option>
                  </select>
                </label>
              </AudienceCommandForm>
            </article>

            {audienceMatrix.channels.map((channel) => {
              const policies = audienceMatrix.policies.filter((policy) => policy.channelId === channel.id);
              const usablePolicies = policies.filter((policy) => policy.currentState !== "SUPERSEDED");
              const latestPolicy = usablePolicies.at(-1) ?? null;
              const priorPolicy = latestPolicy
                ? usablePolicies.filter((policy) => policy.versionNumber < latestPolicy.versionNumber).at(-1) ?? null
                : null;
              const currentRow = catalogedCurrentRelease
                ? audienceMatrix.rows.find((row) =>
                    row.releaseVersionId === catalogedCurrentRelease.id && row.channelId === channel.id)
                  ?? null
                : null;
              return (
                <article className={styles.authorityCard} key={channel.id} data-state={channel.currentState}>
                  <div className={styles.authorityCardHeader}>
                    <div>
                      <h3>{channel.label}</h3>
                      <p>{channel.purpose.replaceAll("_", " ")} · {channel.audience} · {channel.visibility}</p>
                    </div>
                    <span className={styles.stateChip}>{channel.currentState.toLowerCase()}</span>
                  </div>
                  {channel.currentState === "ACTIVE" ? (
                    <div className={styles.channelActions}>
                      <AudienceCommandForm action={audienceAction} label={`Draft policy v${policies.length + 1}`}>
                        <input type="hidden" name="intent" value="CREATE_POLICY" readOnly />
                        <input type="hidden" name="channelId" value={channel.id} readOnly />
                        <input type="hidden" name="idempotencyKey" value={`ui-policy-${channel.id.slice(0, 24)}-${policies.length + 1}`} readOnly />
                        <label>
                          <span>Projection rule</span>
                          <select name="rule" defaultValue="PUBLIC_SCHEDULE">
                            <option value="PUBLIC_SCHEDULE">Public schedule</option>
                            <option value="ACCEPTED_AGENDAS">Accepted agendas</option>
                            <option value="SPEAKER_PORTAL">Speaker portal</option>
                          </select>
                        </label>
                      </AudienceCommandForm>

                      {latestPolicy && catalogedCurrentRelease ? (
                        <AudienceCommandForm action={audienceAction} label={`Bind release v${catalogedCurrentRelease.versionNumber}`}>
                          <input type="hidden" name="intent" value="BIND_RELEASE" readOnly />
                          <input type="hidden" name="channelId" value={channel.id} readOnly />
                          <input type="hidden" name="policyVersionId" value={latestPolicy.id} readOnly />
                          <input type="hidden" name="expectedReleaseId" value={catalogedCurrentRelease.releaseId} readOnly />
                          <input type="hidden" name="expectedReleaseVersion" value={catalogedCurrentRelease.versionNumber} readOnly />
                          <input type="hidden" name="expectedReleaseFingerprint" value={catalogedCurrentRelease.releaseFingerprint} readOnly />
                          <input type="hidden" name="idempotencyKey" value={`ui-bind-${channel.id.slice(0, 18)}-${latestPolicy.versionNumber}-${catalogedCurrentRelease.versionNumber}`} readOnly />
                          <p className={styles.commandEvidence}>Policy v{latestPolicy.versionNumber} · fingerprint {catalogedCurrentRelease.releaseFingerprint.slice(0, 12)}…</p>
                        </AudienceCommandForm>
                      ) : null}

                      {currentRow?.status === "CURRENT" && currentRow.bindingReceiptId ? (
                        <AudienceCommandForm action={audienceAction} label="Disable exact binding">
                          <input type="hidden" name="intent" value="DISABLE_BINDING" readOnly />
                          <input type="hidden" name="channelId" value={channel.id} readOnly />
                          <input type="hidden" name="bindingReceiptId" value={currentRow.bindingReceiptId} readOnly />
                          <input type="hidden" name="expectedReleaseId" value={currentRow.releaseId} readOnly />
                          <input type="hidden" name="expectedReleaseVersion" value={currentRow.releaseVersion} readOnly />
                          <input type="hidden" name="expectedReleaseFingerprint" value={currentRow.releaseFingerprint} readOnly />
                          <input type="hidden" name="idempotencyKey" value={`ui-block-${currentRow.bindingReceiptId.slice(0, 28)}`} readOnly />
                        </AudienceCommandForm>
                      ) : null}

                      {priorPolicy && latestPolicy ? (
                        <AudienceCommandForm action={audienceAction} label={`Supersede policy v${priorPolicy.versionNumber}`}>
                          <input type="hidden" name="intent" value="SUPERSEDE_POLICY" readOnly />
                          <input type="hidden" name="channelId" value={channel.id} readOnly />
                          <input type="hidden" name="policyVersionId" value={priorPolicy.id} readOnly />
                          <input type="hidden" name="expectedPolicyFingerprint" value={priorPolicy.policyFingerprint} readOnly />
                          <input type="hidden" name="successorPolicyVersionId" value={latestPolicy.id} readOnly />
                          <input type="hidden" name="expectedSuccessorPolicyFingerprint" value={latestPolicy.policyFingerprint} readOnly />
                          <input type="hidden" name="idempotencyKey" value={`ui-supersede-${channel.id.slice(0, 18)}-${priorPolicy.versionNumber}-${latestPolicy.versionNumber}`} readOnly />
                        </AudienceCommandForm>
                      ) : null}

                      <AudienceCommandForm action={audienceAction} label="Disable channel">
                        <input type="hidden" name="intent" value="DISABLE_CHANNEL" readOnly />
                        <input type="hidden" name="channelId" value={channel.id} readOnly />
                        <input type="hidden" name="expectedChannelFingerprint" value={channel.fingerprint} readOnly />
                        <input type="hidden" name="idempotencyKey" value={`ui-disable-${channel.id.slice(0, 28)}`} readOnly />
                      </AudienceCommandForm>
                    </div>
                  ) : (
                    <p className={styles.comparisonNotice}>This channel remains inspectable, but its disable receipt permanently blocks new authority.</p>
                  )}
                </article>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className={`${styles.section} ${styles.handoffSection}`} aria-labelledby="publication-readiness-title">
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.eyebrow}>{currentRelease ? "Existing immutable baseline" : "First release handoff"}</p>
            <h2 id="publication-readiness-title">{currentRelease ? "Review the current audience baseline" : "Validate and seal the current release"}</h2>
          </div>
          <div className={styles.statusStrip}>
            <span className={styles.fieldLabel}>State</span>
            <strong className={currentRelease ? styles.statusReady : styles.statusBlocked}>
              {currentRelease ? "Baseline available" : "Server validation required"}
            </strong>
          </div>
        </div>

        <div className={styles.comparisonGrid} data-testid="publication-release-comparison">
          <article>
            <span>Current audience baseline</span>
            <strong>{currentRelease ? `Plan v${content?.planVersionNumber}` : "No sealed baseline"}</strong>
            <p>{currentRelease && content ? `${content.commitmentWatermark} accepted commitments · policy v${content.audiencePolicyVersion}` : "Seal the first validated audience release to establish a comparison baseline."}</p>
          </article>
          <article>
            <span>Next publish handoff</span>
            <strong>Server-selected current approved plan</strong>
            <p>The service revalidates approval, accepted terms, content and artifact gates, and schedule before sealing. Browser state never selects release authority.</p>
          </article>
        </div>

        <p className={styles.comparisonNotice}>
          <strong>Pre-seal diff is not exposed by this service.</strong> An unchanged idempotent
          retry returns the existing durable release; changed authoritative inputs can create a new
          sealed release only after server validation.
        </p>
        {currentRelease ? (
          <details className={styles.supersedeDisclosure} open={!sealState.ok && Boolean(sealState.message)}>
            <summary>Validate current authoritative inputs</summary>
            <div>
              <p>
                The server will revalidate exact plan, commitment, schedule, content, and artifact
                authority. It will either verify the existing immutable release or seal an exact
                successor; this console does not claim an unavailable diff.
              </p>
              <form action={sealFormAction}>
                <button className={`${styles.button} ${styles.buttonPrimary}`} type="submit">
                  Check and seal exact current inputs
                </button>
              </form>
              {sealState.message ? <p className={styles.notice} role="status">{sealState.message}</p> : null}
            </div>
          </details>
        ) : (
          <div className={styles.controls}>
            <form action={sealFormAction}>
              <button className={`${styles.button} ${styles.buttonPrimary}`} type="submit">
                Run checks and seal
              </button>
            </form>
            {sealState.message ? <p className={styles.notice} role="status">{sealState.message}</p> : null}
          </div>
        )}
        <p className={styles.syntheticNote}>
          The organizer action is authenticated, event-scoped, transactional, and idempotent. A
          replay does not create duplicate release rows or portal tokens.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="current-release-title">
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.eyebrow}>Published surface</p>
            <h2 id="current-release-title">Current sealed release</h2>
          </div>
          {publicLink ? <Link className={styles.textLink} href={publicLink}>Open audience view <span aria-hidden="true">→</span></Link> : null}
        </div>
        {content && currentRelease ? (
          <dl className={styles.releaseMeta} data-testid="organizer-source-release">
            <div><dt>Release ID</dt><dd><code>{currentRelease.releaseId}</code></dd></div>
            <div><dt>Content fingerprint</dt><dd><code>{currentRelease.fingerprint}</code></dd></div>
            <div>
              <dt>Sealed at</dt>
              <dd>
                <time data-testid="publication-sealed-at" dateTime={currentRelease.sealedAt}>
                  {formatEventTime(currentRelease.sealedAt, previewTimezone)}
                </time>
              </dd>
            </div>
            <div><dt>Audience</dt><dd>PUBLIC</dd></div>
            <div><dt>Projection schema</dt><dd><code>{content.schema}</code></dd></div>
            <div><dt>Materialized agendas</dt><dd>{content.agendaCount}</dd></div>
          </dl>
        ) : <p className={styles.sectionIntro}>No public output is rendered until a validated sealed current release exists.</p>}
      </section>

      <section className={styles.section} aria-labelledby="redaction-contract-title">
        <div>
          <p className={styles.eyebrow}>Audience boundary</p>
          <h2 id="redaction-contract-title">Truthful durable projection</h2>
        </div>
        <p className={styles.redaction}>{content?.hasSchedule
          ? "The Stage 3 release carries the exact sealed schedule placement and currently approved session title and abstract versions. Email, speaker profile, draft, and plan-rationale fields remain outside the public surface."
          : "The retained legacy release schema carries accepted person and program-unit terms. Room, track, abstract, email, speaker profile, draft, and plan-rationale fields are not in this release and are not reconstructed by the public surface."}</p>
      </section>

      <details className={styles.lineageDisclosure}>
        <summary>Inspect immutable release lineage</summary>
        <section aria-labelledby="publication-lineage-title">
          <div>
            <p className={styles.eyebrow}>Immutable source chain</p>
            <h2 id="publication-lineage-title">Release lineage</h2>
          </div>
          {content ? (
            <div className={styles.lineageGrid}>
              <div className={styles.lineageValue}><span>Event</span><strong>{content.eventName}</strong></div>
              <div className={styles.lineageValue}><span>Source plan version</span><strong>{content.planId} · v{content.planVersionNumber}</strong></div>
              <div className={styles.lineageValue}><span>Plan fingerprint</span><strong><code>{content.planFingerprint}</code></strong></div>
              <div className={styles.lineageValue}><span>Audience policy</span><strong>v{content.audiencePolicyVersion}</strong></div>
              <div className={styles.lineageValue}><span>Commitment watermark</span><strong>{content.commitmentWatermark} accepted</strong></div>
              <div className={styles.lineageValue}>
                <span>Sealed at</span>
                <strong>
                  {currentRelease ? (
                    <time data-testid="publication-lineage-sealed-at" dateTime={currentRelease.sealedAt}>
                      {formatEventTime(currentRelease.sealedAt, previewTimezone)}
                    </time>
                  ) : "Unavailable"}
                </strong>
              </div>
            </div>
          ) : <p className={styles.sectionIntro}>The durable source lineage will appear here after the canonical service seals an approved plan with accepted commitments.</p>}
        </section>
      </details>
    </div>
  );
}
