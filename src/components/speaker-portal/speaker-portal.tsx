import type { ContentPayload } from "@/server/services/content-operations";
import type { SpeakerPortalProjection, SpeakerTaskProjection } from "@/server/services/speaker-operations";
import { getDb } from "@/server/db";
import { listSpeakerArtifactRecords, type SpeakerArtifactRecord } from "@/server/services/artifact-records";
import {
  closeSpeakerPortal,
  completeSpeakerTask,
  respondToSpeakerInvitation,
  submitSpeakerContent,
  updateSpeakerProfile,
} from "@/app/speaker/actions";
import { formatDateTime } from "@/components/truth";

import styles from "./speaker-portal.module.css";

const TASK_STATE_LABELS = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Submitted",
  CHANGES_REQUESTED: "Changes requested",
  COMPLETED: "Completed",
  BLOCKED: "Blocked",
} as const satisfies Record<SpeakerTaskProjection["state"], string>;

const TASK_DUE_STATE_LABELS = {
  UPCOMING: "Upcoming",
  DUE_SOON: "Due soon",
  OVERDUE: "Overdue",
  COMPLETE: "Complete",
} as const satisfies Record<SpeakerTaskProjection["dueState"], string>;

function portalLabel(value: string): string {
  return value.replaceAll("_", " ").toLocaleLowerCase("en-US").replace(/^./u, (character) => character.toLocaleUpperCase("en-US"));
}

function taskStateLabel(state: SpeakerTaskProjection["state"]): string {
  return TASK_STATE_LABELS[state];
}

function taskDueStateLabel(state: SpeakerTaskProjection["dueState"]): string {
  return TASK_DUE_STATE_LABELS[state];
}

const ISO_INSTANT_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gu;

function formatPortalPreview(preview: string): string {
  return preview.replace(ISO_INSTANT_PATTERN, (iso) => formatDateTime(iso));
}

function nextSpeakerObligation(tasks: readonly SpeakerTaskProjection[]): SpeakerTaskProjection | null {
  const open = tasks.filter((task) => task.owner === "SPEAKER" && task.state !== "COMPLETED");
  return open.find((task) => task.state === "CHANGES_REQUESTED")
    ?? open.find((task) => task.dueState === "OVERDUE")
    ?? open.find((task) => task.required && task.state !== "BLOCKED")
    ?? open.find((task) => task.required)
    ?? open[0]
    ?? null;
}

export function SpeakerPortal({ projection, supportPreview }: { readonly projection: SpeakerPortalProjection; readonly supportPreview: boolean }) {
  const accepted = projection.assignment.commitment.state === "ACCEPTED";
  const artifacts = loadPortalArtifacts(projection);
  const nextObligation = nextSpeakerObligation(projection.tasks);
  return <div className={styles.portalPage}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className={styles.topbar}><div className={styles.topbarInner}><p className={styles.brand}>Sympose speaker portal</p><span className={styles.topbarState}>Role-scoped event projection</span></div></header>
    <main className={styles.portalMain} id="main-content" tabIndex={-1}><div className={styles.stack}>
      {supportPreview ? <aside className={styles.supportBanner}><strong>Organizer support preview</strong><br />Synthetic local access · expires with the short-lived preview cookie · actions are attributed to the canonical Person.</aside> : null}
      <header className={styles.header}><div><p className={styles.eyebrow}>Speaker operations</p><h1>Welcome, {projection.person.fullName}</h1><p className={styles.lede}>A focused workspace for exact invitation terms, tasks, profile metadata, content versions, logistics, and readiness. Organizer planning details and other people are not exposed.</p><div className={styles.eventIdentity} aria-label={`Event identity: ${projection.event.name}`}><strong>{projection.event.name}</strong><small>{formatDateTime(projection.assignment.schedule.startsAt)} · {projection.assignment.schedule.timezone} · {projection.assignment.schedule.location}</small></div></div><div className={styles.headerActions}><form action={closeSpeakerPortal}><button className={styles.secondaryButton} type="submit">Close portal</button></form></div></header>
      <nav className={styles.roleNav} aria-label="Speaker portal sections"><a href="#tasks-title">Tasks</a><a href="#readiness-title">Readiness</a><a href="#speaker-secondary-details">More details</a></nav>
      <section className={styles.mobileInstrument} aria-labelledby="speaker-next-title" data-role-instrument="speaker">
        <p className={styles.mobileInstrumentKicker}>Speaker instrument · exact obligations</p>
        <h2 id="speaker-next-title">What needs you</h2>
        {projection.assignment.commitment.state === "PENDING" ? <><strong>Respond to the exact invitation</strong><p>Review the event, session, schedule, and terms below before accepting or declining.</p><a href="#portal-status-title">Review invitation</a></> : nextObligation ? <><strong>{nextObligation.title}</strong><p>{taskDescription(nextObligation)}</p><span>{taskStateLabel(nextObligation.state)} · {taskDueStateLabel(nextObligation.dueState)} · due {formatDateTime(nextObligation.dueAt)}</span><a href={`#speaker-task-${nextObligation.id}`}>Open this task</a></> : <><strong>No speaker-owned obligation is waiting</strong><p>Readiness remains derived from the exact commitments, tasks, submissions, and organizer reviews below.</p><a href="#readiness-title">Review readiness</a></>}
      </section>
      <section className={styles.panel} aria-labelledby="portal-status-title"><div className={styles.panelHeader}><h2 id="portal-status-title">Your invitation and assignment</h2><span className={accepted ? styles.stateGood : styles.stateWarn}>{portalLabel(projection.assignment.commitment.state)}</span></div>{projection.assignment.commitment.state === "PENDING" ? <div className={styles.nextAction}><div><p className={styles.nextActionLabel}>Next action</p><p className={styles.nextActionCopy}>Review the exact offer and choose whether to accept it.</p></div><div className={styles.taskActions}><form action={respondToSpeakerInvitation}><input type="hidden" name="invitationId" value={projection.invitation.id} /><input type="hidden" name="response" value="ACCEPTED" /><button className={styles.primaryButton} type="submit">Accept exact offer</button></form><form action={respondToSpeakerInvitation}><input type="hidden" name="invitationId" value={projection.invitation.id} /><input type="hidden" name="response" value="DECLINED" /><button className={styles.dangerButton} type="submit">Decline offer</button></form></div></div> : null}<dl className={styles.metaGrid}><div><dt>Role</dt><dd>{portalLabel(projection.assignment.role)}</dd></div><div><dt>Session</dt><dd>{projection.assignment.programUnitName}</dd></div><div><dt>When</dt><dd>{formatDateTime(projection.assignment.schedule.startsAt)} → {formatDateTime(projection.assignment.schedule.endsAt)} ({projection.assignment.schedule.timezone})</dd></div><div><dt>Location</dt><dd>{projection.assignment.schedule.location}</dd></div><div><dt>Invitation</dt><dd>{portalLabel(projection.invitation.state)}</dd></div><div><dt>Response</dt><dd>{projection.invitation.response?.respondedAt ? formatDateTime(projection.invitation.response.respondedAt) : "Awaiting response"}</dd></div></dl><details className={styles.evidenceDisclosure}><summary>Technical invitation evidence</summary><dl className={styles.metaGrid}><div><dt>Exact terms</dt><dd><code>{projection.invitation.termsFingerprint}</code></dd></div><div><dt>Delivery evidence</dt><dd>{portalLabel(projection.invitation.deliveryEvidence.deliveryState)} · simulated</dd></div></dl></details></section>
      <section className={styles.panel} aria-labelledby="tasks-title"><div className={styles.panelHeader}><h2 id="tasks-title">Tasks and submissions</h2><span className={styles.muted}>{projection.tasks.filter((task) => task.state === "COMPLETED").length} / {projection.tasks.length} complete</span></div><ul className={styles.taskList}>{projection.tasks.map((task) => <li key={task.id}><TaskCard task={task} artifacts={artifacts === null ? null : artifacts.filter((artifact) => artifact.taskId === task.id)} /></li>)}</ul></section>
      <section className={styles.panel} aria-labelledby="readiness-title"><div className={styles.panelHeader}><h2 id="readiness-title">Readiness</h2><span className={projection.readiness.eligible ? styles.stateGood : styles.stateWarn}>{projection.readiness.eligible ? "Ready" : "Action needed"}</span></div><p className={styles.muted}>Computed at {formatDateTime(projection.readiness.asOf)}; no mutable ready flag is stored.</p><div className={styles.tableWrap}><table className={styles.table}><caption>Deterministic gate evaluation</caption><thead><tr><th scope="col">Gate</th><th scope="col">State</th><th scope="col">Blockers</th></tr></thead><tbody>{projection.readiness.gates.map((gate) => <tr key={gate.gate}><td>{portalLabel(gate.gate)}</td><td>{gate.eligible ? "Eligible" : "Blocked"}</td><td>{gate.blockerCodes.length ? gate.blockerCodes.map(portalLabel).join(", ") : "None"}</td></tr>)}</tbody></table></div></section>
      <div className={styles.secondaryStack} id="speaker-secondary-details">
      <details className={`${styles.panel} ${styles.secondaryPanel}`}><summary><span><strong>Messages and reminders</strong><small>Invitation and delivery history</small></span><span className={styles.muted}>{projection.communications.length} receipt(s)</span></summary><div className={styles.secondaryPanelBody} id="communication-history-title"><ul className={styles.noticeList}>{projection.communications.map((evidence) => <li key={evidence.id}><strong>{portalLabel(evidence.kind)}</strong> · {portalLabel(evidence.deliveryState)} · <time dateTime={evidence.occurredAt}>{formatDateTime(evidence.occurredAt)}</time><br /><span className={styles.muted}>{formatPortalPreview(evidence.renderedPreview)}</span><br /><span className={styles.muted}>Communication evidence is separate from your commitment response.</span></li>)}</ul></div></details>
      <ProfilePanel projection={projection} />
      <details className={`${styles.panel} ${styles.secondaryPanel}`}><summary><span><strong>Travel and onsite details</strong><small>Arrival, travel, dietary, and source state</small></span><span className={styles.badge}>{portalLabel(projection.logistics.status)}</span></summary><div className={styles.secondaryPanelBody} id="logistics-title"><dl className={styles.metaGrid}><div><dt>Arrival window</dt><dd>{projection.logistics.arrivalWindow ?? "Not collected"}</dd></div><div><dt>Travel mode</dt><dd>{portalLabel(projection.logistics.travelMode)}</dd></div><div><dt>Dietary notes</dt><dd>{projection.logistics.dietaryNotesProvided ? "Provided" : "Not provided"}</dd></div><div><dt>Evidence</dt><dd><details className={styles.inlineDisclosure}><summary>Source fingerprint</summary><code>{projection.logistics.sourceEvidence.fingerprint}</code></details></dd></div></dl></div></details>
      <details className={`${styles.panel} ${styles.secondaryPanel}`}><summary><span><strong>Version and review history</strong><small>Organizer decisions on exact content versions</small></span><span className={styles.muted}>{projection.contentReviews.length} stream(s)</span></summary><div className={styles.secondaryPanelBody} id="review-history-title">{projection.contentReviews.length === 0 ? <p className={styles.empty}>No content review history yet.</p> : <ul className={styles.reviewList}>{projection.contentReviews.map((review) => <li className={styles.reviewCard} key={`${review.taskId}-${review.kind}`}><h3>{portalLabel(review.kind)}</h3>{review.versions.map((version) => <div key={version.id}><p><strong>Version {version.version}</strong> · {portalLabel(version.reviewState)}</p><details className={styles.inlineDisclosure}><summary>Technical version evidence</summary><p><code>{version.contentHash}</code></p></details>{review.comments.filter((comment) => comment.submissionVersionId === version.id).map((comment) => <p className={styles.muted} key={comment.id}>Comment on this exact version: {comment.body}</p>)}{review.findings.filter((finding) => finding.submissionVersionId === version.id).map((finding) => <p className={styles.muted} key={finding.id}>{portalLabel(finding.severity)}: {finding.message}</p>)}</div>)}</li>)}</ul>}</div></details>
      <details className={styles.dataBoundary}><summary>Local preview and data-handling details</summary><p className={styles.footerNote}>{projection.localProjectionNotice.replaceAll("-", " ")} · task changes plus profile/text versions and reviews persist in local SQLite. PNG/PDF artifact evidence persists there and exact bytes use authenticated local filesystem storage; no scanning, object-storage provider, SMTP, or email delivery is claimed. Communications are evidence boundaries, not acceptance.</p></details>
      </div>
    </div></main>
  </div>;
}

function loadPortalArtifacts(projection: SpeakerPortalProjection): readonly SpeakerArtifactRecord[] | null {
  try {
    return listSpeakerArtifactRecords(getDb(), {
      workspaceId: projection.access.workspaceId,
      eventId: projection.access.eventId,
      personId: projection.access.personId,
    });
  } catch {
    return null;
  }
}

function ProfilePanel({ projection }: { readonly projection: SpeakerPortalProjection }) {
  const profile = projection.profile.eventOverride;
  const profileTaskConfigured = projection.tasks.some(
    (task) => task.kind === "PROFILE" && task.contentKind === "PROFILE",
  );
  return <details className={`${styles.panel} ${styles.secondaryPanel}`} open={Boolean(projection.profile.pendingRevision)}><summary><span><strong>Public speaker profile</strong><small>Bio, title, organization, and social links</small></span>{projection.profile.pendingRevision ? <span className={styles.stateWarn}>Pending revision</span> : <span className={styles.stateGood}>Approved snapshot</span>}</summary><div className={styles.secondaryPanelBody}><p className={styles.muted}>Public snapshots remain unchanged while a new revision is pending approval.</p><form action={updateSpeakerProfile} className={styles.taskForm} id="profile-title"><input type="hidden" name="idempotencyKey" value={`speaker-profile:${projection.profile.pendingRevision?.versionId ?? projection.profile.workspaceProfile.sourceVersionId}`} /><div className={styles.profileGrid}><label className={`${styles.field} ${styles.fieldWide}`}>Bio<textarea name="bio" defaultValue={profile.bio} maxLength={12000} required /></label><label className={styles.field}>Public title<input name="publicTitle" defaultValue={profile.publicTitle} maxLength={240} required /></label><label className={styles.field}>Organization<input name="organization" defaultValue={profile.organization} maxLength={240} required /></label><label className={`${styles.field} ${styles.fieldWide}`}>Social links JSON<input name="socialLinksJson" defaultValue={JSON.stringify(profile.socialLinks)} maxLength={16000} required /></label></div><p className={styles.muted}>Headshots are uploaded through the assigned HEADSHOT task so each byte set has its own immutable version and authenticated download.</p><p className={styles.muted} id="profile-task-prerequisite">{profileTaskConfigured ? "Profile changes create a new immutable PROFILE version." : "An organizer must assign a profile revision task before changes can be submitted."}</p><button aria-describedby="profile-task-prerequisite" className={styles.primaryButton} disabled={!profileTaskConfigured} type="submit">Submit profile revision</button></form></div></details>;
}

function TaskCard({ task, artifacts }: { readonly task: SpeakerTaskProjection; readonly artifacts: readonly SpeakerArtifactRecord[] | null }) {
  const content = task.review?.versions.at(-1)?.payload;
  return <article className={styles.taskCard} id={`speaker-task-${task.id}`}><header><div><h3>{task.title}</h3><p className={styles.muted}>{taskDescription(task)}</p></div><span className={task.state === "COMPLETED" ? styles.stateGood : task.state === "BLOCKED" || task.state === "CHANGES_REQUESTED" ? styles.stateWarn : styles.state}>{taskStateLabel(task.state)}</span></header><div className={styles.taskMeta}><span>{task.required ? "Required" : "Optional"}</span><span>{portalLabel(task.owner)}</span><span>Due {formatDateTime(task.dueAt)} ({taskDueStateLabel(task.dueState)})</span>{task.submissionVersionId ? <details className={styles.inlineDisclosure}><summary>Version evidence</summary><code>{task.submissionVersionId}</code></details> : null}</div>{task.contentKind === "PROFILE" ? null : task.contentKind ? <ContentTaskForm task={task} content={content} artifacts={artifacts} /> : task.state !== "COMPLETED" ? <form action={completeSpeakerTask} className={styles.taskForm}><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="idempotencyKey" value={`complete-task:${task.id}:${task.state}`} /><label className={styles.field}>Completion note<input name="note" maxLength={1000} /></label><button className={styles.primaryButton} type="submit">Mark complete</button></form> : null}</article>;
}

function taskDescription(task: SpeakerTaskProjection): string {
  if (task.contentKind === "HEADSHOT") return "Upload one bounded PNG headshot. Each upload is retained as an immutable version.";
  if (task.contentKind === "SLIDES") return "Upload one bounded PDF slide deck or supporting asset. Each upload is retained as an immutable version.";
  return task.description;
}

function ContentTaskForm({ task, content, artifacts }: { readonly task: SpeakerTaskProjection; readonly content?: ContentPayload; readonly artifacts: readonly SpeakerArtifactRecord[] | null }) {
  const payload = content && content.kind === task.contentKind ? content : null;
  return <form action={submitSpeakerContent} className={styles.taskForm}><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="contentKind" value={task.contentKind ?? ""} /><input type="hidden" name="idempotencyKey" value={`submit-content:${task.id}:${task.submissionVersionId ?? "new"}`} />
    {task.contentKind === "BIO" ? <label className={styles.field}>Bio<textarea name="bio" defaultValue={payload?.kind === "BIO" ? payload.bio : ""} maxLength={12000} required /></label> : null}
    {task.contentKind === "SESSION_TITLE" ? <label className={styles.field}>Title<input name="title" defaultValue={payload?.kind === "SESSION_TITLE" ? payload.title : ""} maxLength={240} required /></label> : null}
    {task.contentKind === "SESSION_DESCRIPTION" ? <label className={styles.field}>Description<textarea name="description" defaultValue={payload?.kind === "SESSION_DESCRIPTION" ? payload.description : ""} maxLength={12000} required /></label> : null}
    {task.contentKind === "SOCIAL_LINKS" ? <label className={styles.field}>Links JSON<input name="linksJson" defaultValue={payload?.kind === "SOCIAL_LINKS" ? JSON.stringify(payload.links) : "[]"} maxLength={16000} required /></label> : null}
    {task.contentKind === "LOGISTICS" ? <div className={styles.taskFormGrid}><label className={styles.field}>Arrival window<input name="arrivalWindow" defaultValue={payload?.kind === "LOGISTICS" ? payload.arrivalWindow : ""} maxLength={240} required /></label><label className={styles.field}>Travel mode<select name="travelMode" defaultValue={payload?.kind === "LOGISTICS" ? payload.travelMode : "UNKNOWN"}><option>LOCAL</option><option>TRAIN</option><option>AIR</option><option>REMOTE</option><option>UNKNOWN</option></select></label><label className={`${styles.field} ${styles.fieldWide}`}>Dietary notes<input name="dietaryNotes" defaultValue={payload?.kind === "LOGISTICS" ? payload.dietaryNotes : ""} maxLength={1000} /></label></div> : null}
    {task.contentKind === "ACKNOWLEDGEMENT" ? <><label className={styles.field}>Statement ID<input name="statementId" defaultValue={payload?.kind === "ACKNOWLEDGEMENT" ? payload.statementId : "speaker-briefing-v1"} maxLength={160} required /></label><input type="hidden" name="acknowledged" value="true" /></> : null}
    {task.contentKind === "HEADSHOT" || task.contentKind === "SLIDES" ? <ArtifactFileFields task={task} artifacts={artifacts} /> : null}
    <button className={styles.primaryButton} type="submit">Submit new immutable version</button>
  </form>;
}

function ArtifactFileFields({ task, artifacts }: { readonly task: SpeakerTaskProjection; readonly artifacts: readonly SpeakerArtifactRecord[] | null }) {
  const accept = task.contentKind === "HEADSHOT" ? "image/png" : "application/pdf";
  const label = task.contentKind === "HEADSHOT" ? "headshot PNG" : "slides PDF";
  const limit = task.contentKind === "HEADSHOT" ? "8 MiB" : "25 MiB";
  return <div className={styles.taskFormGrid}><label className={`${styles.field} ${styles.fieldWide}`}>Upload {label}<input name="artifactFile" type="file" accept={accept} required /><span className={styles.muted}>{accept} only · maximum {limit}</span></label><p className={`${styles.muted} ${styles.fieldWide}`}>The server validates MIME, signature, size, and SHA-256 before recording an immutable local artifact. Private downloads remain portal-scoped; only an organizer-approved headshot explicitly bound to a sealed public release can appear on that release. No scanning or provider delivery is claimed.</p>{artifacts === null ? <p className={`${styles.muted} ${styles.fieldWide}`}>Uploaded version history is temporarily unavailable; existing bytes are not listed.</p> : artifacts.length > 0 ? <div className={`${styles.fieldWide} ${styles.artifactHistory}`}><strong>Uploaded versions</strong><ul>{artifacts.map((artifact) => <li key={artifact.artifactId}><a href={`/speaker/artifacts/${artifact.artifactId}`}>{artifact.displayFilename}</a> · v{artifact.version} · {formatBytes(artifact.byteSize)} · {artifact.current ? "current" : "superseded"}</li>)}</ul></div> : null}</div>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
