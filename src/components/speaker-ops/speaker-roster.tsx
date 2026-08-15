import Link from "next/link";

import { formatDateTime } from "@/components/truth";
import { getDb } from "@/server/db";
import { listSpeakerArtifactRecords, type SpeakerArtifactRecord } from "@/server/services/artifact-records";
import type {
  ManualSpeakerRecord,
  SpeakerCsvImportReceipt,
  SpeakerOrganizerProjection,
  SpeakerRosterFilter,
  SpeakerRosterRecord,
  SpeakerTaskProjection,
  SpeakerWorkflowStatus,
} from "@/server/services/speaker-operations";
import { listManualSpeakerRecords, ORGANIZER_SPEAKER_TASK_TEMPLATES, SPEAKER_CSV_IMPORT_COLUMNS, SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS, SPEAKER_CSV_MAX_CHARACTERS, SPEAKER_CSV_MAX_ROWS, SPEAKER_WORKFLOW_STATUSES } from "@/server/services/speaker-operations";
import {
  addSpeakerComment,
  addSpeakerFinding,
  approveSpeakerContent,
  createManualSpeaker,
  createSpeakerTask,
  editManualSpeaker,
  importSpeakerCsv,
  openSyntheticSpeakerPortalPreview,
  restoreSpeakerContent,
  requestSpeakerRevision,
  saveOrganizerSessionContent,
  saveOrganizerSpeakerProfile,
  sendSpeakerInvitation,
  updateSpeakerWorkflowStatus,
  updateSpeakerTask,
} from "@/app/w/[workspace]/events/[eventId]/speakers/actions";

import styles from "./speaker-ops.module.css";

export function speakerFilterFromSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
): SpeakerRosterFilter {
  const value = (key: string): string | undefined => {
    const raw = searchParams[key];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const role = value("role");
  const invitationState = value("invitation");
  const commitmentState = value("commitment");
  const taskState = value("task");
  const workflowStatus = value("status") ?? value("workflow");
  return {
    query: value("q"),
    role: role === "SPEAKER" || role === "MODERATOR" ? role : undefined,
    workflowStatus: SPEAKER_WORKFLOW_STATUSES.includes(workflowStatus as SpeakerWorkflowStatus) ? workflowStatus as SpeakerWorkflowStatus : undefined,
    invitationState: invitationState === "DRAFT" || invitationState === "READY" || invitationState === "SENT" || invitationState === "DELIVERED" || invitationState === "OPENED" || invitationState === "RESPONDED" || invitationState === "EXPIRED" || invitationState === "CANCELED" ? invitationState : undefined,
    commitmentState: commitmentState === "PENDING" || commitmentState === "ACCEPTED" || commitmentState === "DECLINED" || commitmentState === "WITHDRAWN" || commitmentState === "RECONFIRMATION_REQUIRED" ? commitmentState : undefined,
    taskState: taskState === "NOT_STARTED" || taskState === "IN_PROGRESS" || taskState === "SUBMITTED" || taskState === "CHANGES_REQUESTED" || taskState === "COMPLETED" || taskState === "BLOCKED" ? taskState : undefined,
    overdueOnly: value("overdue") === "1",
  };
}

function loadRosterArtifacts(projection: SpeakerOrganizerProjection): readonly SpeakerArtifactRecord[] | null {
  try {
    return listSpeakerArtifactRecords(getDb(), {
      workspaceId: projection.access.workspaceId,
      eventId: projection.event.id,
    });
  } catch {
    return null;
  }
}

export function SpeakerRoster({
  workspace,
  projection,
  filter,
}: {
  readonly workspace: string;
  readonly projection: SpeakerOrganizerProjection;
  readonly filter: SpeakerRosterFilter;
}) {
  const artifacts = loadRosterArtifacts(projection);
  const manualSpeakerLoad = loadManualSpeakerRecords(projection, filter);
  const manualSpeakers = manualSpeakerLoad.records;
  const rosterPriority = (record: SpeakerRosterRecord): number => {
    if (!record.readiness.eligible || record.tasks.some((task) => task.state === "BLOCKED" || task.state === "CHANGES_REQUESTED")) return 0;
    if (record.tasks.some((task) => task.dueState === "OVERDUE")) return 1;
    if (record.tasks.some((task) => task.review && task.review.versions.length > 0 && task.review.latestReviewState !== "APPROVED")) return 2;
    if (record.assignment.commitment.state !== "ACCEPTED") return 3;
    return 4;
  };
  const prioritizedRoster = [...projection.roster].sort((left, right) => rosterPriority(left) - rosterPriority(right) || left.person.fullName.localeCompare(right.person.fullName));
  const visibleRosterCount = projection.roster.length + manualSpeakers.length;
  const blockedPeopleCount = projection.roster.filter((record) => !record.readiness.eligible).length;
  const contentReviewCount = projection.roster.reduce(
    (count, record) => count + record.tasks.filter((task) =>
      task.review && task.review.versions.length > 0 && task.review.latestReviewState !== "APPROVED"
    ).length,
    0,
  );
  const hasPriorityWork = projection.dashboard.readinessBlockerCount > 0
    || projection.dashboard.overdueTaskCount > 0
    || contentReviewCount > 0
    || projection.dashboard.awaitingResponseCount > 0;
  const rosterTable = visibleRosterCount > 0 ? (
    <div className={styles.tableWrap} role="region" aria-label="Speaker roster table" tabIndex={0}>
      <table className={`${styles.table} ${styles.rosterTable}`}>
        <caption>Canonical people with event-scoped speaker and moderator projections</caption>
        <thead><tr><th scope="col">Person</th><th scope="col">Assignment / workflow<span className={styles.tableHeaderDetail}>Decision context and organizer projection</span></th><th scope="col">Invitation / commitment<span className={styles.tableHeaderDetail}>Delivery evidence remains separate</span></th><th scope="col">Tasks / readiness<span className={styles.tableHeaderDetail}>Current work and deterministic gates</span></th><th scope="col">Organizer actions</th><th scope="col">Evidence / history</th></tr></thead>
        <tbody>{prioritizedRoster.map((record) => <RosterRow key={record.person.personId} workspace={workspace} eventId={projection.event.id} record={record} artifacts={artifacts === null ? null : artifacts.filter((artifact) => artifact.personId === record.person.personId)} />)}{manualSpeakers.map((record) => <ManualSpeakerRow key={record.eventSpeakerId} workspace={workspace} eventId={projection.event.id} record={record} artifacts={artifacts === null ? null : artifacts.filter((artifact) => artifact.personId === record.personId)} />)}</tbody>
      </table>
    </div>
  ) : null;
  return (
    <div className={styles.stack}>
      <section className={styles.attentionPanel} aria-labelledby="speaker-attention-title">
        <div className={styles.attentionHeader}>
          <div><p className={styles.eyebrow}>Attention first · current authorized view</p><h2 id="speaker-attention-title">Needs attention</h2></div>
          <span className={hasPriorityWork ? styles.statusWarn : styles.statusGood}>{hasPriorityWork ? "Action required" : "No priority work"}</span>
        </div>
        {hasPriorityWork ? <div className={styles.attentionList}>
          {projection.dashboard.readinessBlockerCount > 0 ? <AttentionItem href="#readiness-matrix-title" priority="Blocked" label={`${projection.dashboard.readinessBlockerCount} readiness gate${projection.dashboard.readinessBlockerCount === 1 ? "" : "s"}`} detail={`Across ${blockedPeopleCount} assigned ${blockedPeopleCount === 1 ? "person" : "people"}; inspect deterministic evidence.`} /> : null}
          {projection.dashboard.overdueTaskCount > 0 ? <AttentionItem href="#speaker-deliverables-work" priority="Overdue" label={`${projection.dashboard.overdueTaskCount} task${projection.dashboard.overdueTaskCount === 1 ? "" : "s"} past due`} detail="Work the overdue and blocked deliverables before routine follow-up." /> : null}
          {contentReviewCount > 0 ? <AttentionItem href="#content-review-title" priority="Unapproved" label={`${contentReviewCount} content stream${contentReviewCount === 1 ? "" : "s"} ${contentReviewCount === 1 ? "needs" : "need"} review`} detail="Approval actions remain bound to one exact version and content hash." /> : null}
          {projection.dashboard.awaitingResponseCount > 0 ? <AttentionItem href="#speaker-roster-title" priority="Waiting" label={`${projection.dashboard.awaitingResponseCount} invitation response${projection.dashboard.awaitingResponseCount === 1 ? "" : "s"} outstanding`} detail="Delivery evidence does not imply participant commitment." /> : null}
        </div> : <p className={styles.attentionEmpty}>No blocked readiness gates, overdue tasks, unapproved submissions, or outstanding responses appear in this view.</p>}
        <div className={styles.summaryStrip} aria-label="Speaker operations summary">
          <SummaryStat label="People visible" value={visibleRosterCount} />
          <SummaryStat label="Accepted commitments" value={projection.dashboard.acceptedCommitmentCount} />
          <SummaryStat label="Submitted content" value={projection.dashboard.submittedContentCount} />
          <SummaryStat label="As of" value={formatDateTime(projection.asOf)} compact />
        </div>
      </section>

      <section className={`${styles.panel} ${styles.workPanel}`} aria-labelledby="speaker-roster-title">
        <div className={styles.panelHeader}>
          <div><p className={styles.eyebrow}>Routine work · canonical Person-backed roster</p><h2 id="speaker-roster-title">Speaker work queue</h2></div>
          <a className={styles.secondaryButton} href={`/w/${workspace}/events/${projection.event.id}/speakers/export`}>Download readiness CSV</a>
        </div>
        <div className={styles.filterHeader}><h3 id="roster-filter-title">Find people</h3><span className={styles.badge}>{visibleRosterCount} visible</span></div>
        <form className={styles.filters} method="get">
          <label>Search <input name="q" defaultValue={filter.query ?? ""} placeholder="Name, organization, session" /></label>
          <label>Role <select name="role" defaultValue={filter.role ?? ""}><option value="">All roles</option><option value="SPEAKER">Speaker</option><option value="MODERATOR">Moderator</option></select></label>
          <label>Workflow status <select name="status" defaultValue={filter.workflowStatus ?? ""}><option value="">All workflow statuses</option>{SPEAKER_WORKFLOW_STATUSES.map((status) => <option key={status} value={status}>{workflowStatusLabel(status)}</option>)}</select></label>
          <label>Invitation <select name="invitation" defaultValue={filter.invitationState ?? ""}><option value="">All invitation states</option><option value="DRAFT">Draft</option><option value="READY">Ready</option><option value="SENT">Sent</option><option value="DELIVERED">Delivered</option><option value="OPENED">Opened</option><option value="RESPONDED">Responded</option><option value="EXPIRED">Expired</option><option value="CANCELED">Canceled</option></select></label>
          <label>Commitment <select name="commitment" defaultValue={filter.commitmentState ?? ""}><option value="">All commitment states</option><option value="PENDING">Pending</option><option value="ACCEPTED">Accepted</option><option value="DECLINED">Declined</option><option value="RECONFIRMATION_REQUIRED">Reconfirmation required</option></select></label>
          <label>Task <select name="task" defaultValue={filter.taskState ?? ""}><option value="">Any task state</option><option value="NOT_STARTED">Not started</option><option value="SUBMITTED">Submitted</option><option value="CHANGES_REQUESTED">Changes requested</option><option value="COMPLETED">Completed</option><option value="BLOCKED">Blocked</option></select></label>
          <label className={styles.checkLabel}><input type="checkbox" name="overdue" value="1" defaultChecked={filter.overdueOnly} /> Overdue only</label>
          <button className={styles.primaryButton} type="submit">Apply filters</button>
          <Link className={styles.secondaryButton} href={`/w/${workspace}/events/${projection.event.id}/speakers`}>Clear</Link>
        </form>
        <p className={styles.muted}>Filters query this authorized event projection. Workflow status is an organizer-owned operational projection; person identity, decision, commitment, task, readiness, and simulated delivery evidence remain separate.</p>
        {manualSpeakerLoad.status === "unavailable" ? <p className={styles.statusWarn} role="alert">Manual speaker entries are temporarily unavailable. The displayed event roster may be incomplete; retry to load the complete roster.</p> : null}
        {manualSpeakerLoad.status === "available" && visibleRosterCount === 0 ? <p className={styles.empty}>No authorized speakers match the current filters.</p> : rosterTable}
      </section>

      <SpeakerDeliverables workspace={workspace} projection={projection} />

      <details className={styles.setupDisclosure} open>
        <summary><span><strong>Setup and intake</strong><small>Add one canonical person, run a bounded CSV merge, or assign a new file request.</small></span><span className={styles.disclosureCue}>Routine setup</span></summary>
        <div className={styles.setupStack}>
          <ManualSpeakerCreatePanel workspace={workspace} eventId={projection.event.id} />
          <SpeakerCsvImportPanel workspace={workspace} projection={projection} />
          <TaskRequestPanel workspace={workspace} projection={projection} />
        </div>
      </details>

      <details className={styles.auditDisclosure}>
        <summary><span><strong id="readiness-matrix-title">Readiness evidence and activity</strong><small>Expand the deterministic matrix, blocker codes, completion counts, and activity timestamps.</small></span><span className={styles.disclosureCue}>As of {formatDateTime(projection.asOf)}</span></summary>
        {projection.readinessMatrix.length === 0 ? <p className={styles.empty}>No assigned speakers are available for readiness evaluation in this view.</p> : <div className={styles.tableWrap} role="region" aria-label="Speaker readiness evidence table" tabIndex={0}><table className={styles.table}><caption>Required task completion and deterministic readiness blockers</caption><thead><tr><th scope="col">Person</th><th scope="col">Commitment</th><th scope="col">Required tasks</th><th scope="col">Overdue</th><th scope="col">Blockers</th><th scope="col">Last activity</th></tr></thead><tbody>{projection.readinessMatrix.map((row) => <tr key={row.personId}><td>{row.personName}<br /><span className={styles.muted}>{row.role}</span></td><td>{row.commitmentState}</td><td>{row.completedRequiredTaskCount} / {row.requiredTaskCount}</td><td>{row.overdueTaskCount}</td><td>{row.blockers.length ? row.blockers.join(", ") : "None"}</td><td><time dateTime={row.lastActivityAt}>{row.lastActivityAt}</time></td></tr>)}</tbody></table></div>}
      </details>
    </div>
  );
}

function AttentionItem({ href, priority, label, detail }: { readonly href: string; readonly priority: string; readonly label: string; readonly detail: string }) {
  return <a className={styles.attentionItem} href={href}><span className={styles.attentionPriority}>{priority}</span><span><strong>{label}</strong><small>{detail}</small></span><span className={styles.attentionLink}>Review</span></a>;
}

function SummaryStat({ label, value, compact = false }: { readonly label: string; readonly value: number | string; readonly compact?: boolean }) {
  return <div className={styles.summaryStat}><span>{label}</span><strong className={compact ? styles.compactValue : undefined}>{value}</strong></div>;
}

type ManualSpeakerRosterLoad =
  | { readonly status: "available"; readonly records: readonly ManualSpeakerRecord[] }
  | { readonly status: "unavailable"; readonly records: readonly [] };

function loadManualSpeakerRecords(projection: SpeakerOrganizerProjection, filter: SpeakerRosterFilter): ManualSpeakerRosterLoad {
  try {
    const existingPersonIds = new Set(projection.roster.map((record) => record.person.personId));
    return { status: "available", records: listManualSpeakerRecords(getDb(), projection.access, filter).filter((record) => !existingPersonIds.has(record.personId)) };
  } catch {
    return { status: "unavailable", records: [] };
  }
}

function ManualSpeakerCreatePanel({ workspace, eventId }: { readonly workspace: string; readonly eventId: string }) {
  return <section className={styles.panel} aria-labelledby="manual-speaker-create-title">
    <div className={styles.panelHeader}><div><p className={styles.eyebrow}>Canonical Person intake</p><h2 id="manual-speaker-create-title">Add a speaker manually</h2></div><span className={styles.badge}>Organizer-only</span></div>
    <p className={styles.muted}>Create or link one canonical Person to this event. A matching normalized email links the existing workspace Person; it never copies a speaker identity between events.</p>
    <form action={createManualSpeaker} className={styles.editorForm}>
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="eventId" value={eventId} />
      <div className={styles.inlineFields}><label>Full name<input name="fullName" maxLength={240} autoComplete="name" required /></label><label>Email<input name="email" type="email" maxLength={320} autoComplete="email" required /></label><label>Title<input name="title" maxLength={240} autoComplete="organization-title" /></label></div>
      <div className={styles.inlineFields}><label>Organization / company<input name="organization" maxLength={240} autoComplete="organization" /></label><span className={styles.manualSpeakerNote}>Email is used for workspace identity matching and is read-only after creation.</span></div>
      <label>Bio<textarea name="bio" maxLength={4_000} rows={4} /></label>
      <button className={styles.primaryButton} type="submit">Create or link speaker</button>
    </form>
    <p className={styles.muted}>After saving, the speaker appears in this event roster after reload. Profile edits append provenance; invitation, commitment, task, and portal states remain separate until their workflows create them.</p>
  </section>;
}

function SpeakerCsvImportPanel({ workspace, projection }: { readonly workspace: string; readonly projection: SpeakerOrganizerProjection }) {
  const receipt = projection.lastCsvImport;
  const evaluatorExample = `${SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS.join(",")}\nDana Example,dana@example.test,Staff Engineer,Example Labs,"Speaker bio with, a comma"`;
  const legacyExample = `${SPEAKER_CSV_IMPORT_COLUMNS.join(",")}\nJamie Example,jamie@example.test,Example Lab,Researcher,SPEAKER,Opening session`;
  return <section className={styles.panel} aria-labelledby="speaker-csv-import-title">
    <div className={styles.panelHeader}><div><p className={styles.eyebrow}>Bounded organizer intake</p><h2 id="speaker-csv-import-title">Import or merge speakers from CSV</h2></div>{receipt ? <span className={styles.badge}>{receipt.createdCount} created · {receipt.mergedCount} merged · {receipt.rejectedCount} rejected</span> : null}</div>
    <p className={styles.muted}>Upload up to {SPEAKER_CSV_MAX_ROWS} UTF-8 rows using the evaluator header <code>{SPEAKER_CSV_IMPORT_EVALUATOR_COLUMNS.join(",")}</code>. The file path is never retained; company maps to organization and bio is retained. The legacy text fallback accepts <code>{SPEAKER_CSV_IMPORT_COLUMNS.join(",")}</code>. Matching email or normalized name plus organization retains the existing canonical Person ID.</p>
    <form action={importSpeakerCsv} className={styles.editorForm}>
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="eventId" value={projection.event.id} />
      <label>CSV file<input name="csvFile" type="file" accept=".csv,text/csv,text/plain" /></label>
      <label>Legacy CSV text fallback<textarea className={styles.csvImportText} name="csvText" defaultValue={legacyExample} maxLength={SPEAKER_CSV_MAX_CHARACTERS} rows={6} /></label>
      <button className={styles.primaryButton} type="submit">Import or merge speakers</button>
    </form>
    <p className={styles.muted}>Evaluator example: <code>{evaluatorExample}</code>. Import is bounded and workspace/event-scoped. It sends no email and leaves assignments, commitments, and immutable content history separate.</p>
    {receipt ? <CsvImportReceipt receipt={receipt} /> : null}
  </section>;
}

function CsvImportReceipt({ receipt }: { readonly receipt: SpeakerCsvImportReceipt }) {
  return <div className={styles.csvReceipt} role="status" aria-live="polite">
    <strong>Import receipt {receipt.receiptId}</strong>
    <span className={styles.muted}>Processed {receipt.rowCount} row(s) at {receipt.occurredAt} · email sent: {String(receipt.emailSent)} · file bytes stored: {String(receipt.fileBytesStored)}</span>
    <ul className={styles.csvReceiptRows}>{receipt.rows.map((row) => <li key={`${receipt.receiptId}-${row.rowNumber}`}><span className={row.status === "CREATED" ? styles.statusGood : row.status === "MERGED" ? styles.status : styles.statusWarn}>{row.status}</span> <strong>row {row.rowNumber}</strong>{row.personId ? <> · <code>{row.personId}</code></> : null}<br /><span className={styles.muted}>{row.detail}</span></li>)}</ul>
  </div>;
}

function RosterRow({ workspace, eventId, record, artifacts }: { readonly workspace: string; readonly eventId: string; readonly record: SpeakerRosterRecord; readonly artifacts: readonly SpeakerArtifactRecord[] | null }) {
  const accepted = record.assignment.commitment.state === "ACCEPTED";
  const pendingTask = record.tasks.find((task) => task.required && task.state !== "COMPLETED");
  const pendingActionTask = record.tasks.find((task) => task.kind === "ACTION" && task.state !== "COMPLETED");
  const completedRequiredTaskCount = record.tasks.filter((task) => task.required && task.state === "COMPLETED").length;
  const requiredTaskCount = record.tasks.filter((task) => task.required).length;
  const blockedGates = record.readiness.gates.filter((gate) => !gate.eligible);
  const needsAttention = !record.readiness.eligible || record.tasks.some((task) => task.dueState === "OVERDUE" || task.state === "BLOCKED" || task.state === "CHANGES_REQUESTED");
  const profileTask = record.tasks.find((task) => task.kind === "PROFILE" && task.contentKind === "PROFILE");
  const profileVersion = profileTask?.review?.versions.at(-1)?.payload;
  const profile = profileVersion?.kind === "PROFILE" ? profileVersion : record.profile.eventOverride;
  return <tr className={needsAttention ? styles.attentionRow : undefined}>
    <td data-label="Person"><div className={styles.personCell}><span className={styles.layerLabel}>Canonical person</span><strong>{record.person.fullName}</strong><span className={styles.muted}>{record.person.title} · {record.person.organization}</span><code>{record.person.personId}</code></div></td>
    <td data-label="Assignment / workflow"><div className={styles.evidenceCell}><span className={styles.layerLabel}>Decision context</span><strong>{record.role} · {record.assignment.programUnitName}</strong><span className={styles.muted}>{record.assignment.schedule.location}</span><span className={styles.layerLabel}>Organizer workflow</span><span className={styles.status}>{workflowStatusLabel(record.workflowStatus)}</span></div></td>
    <td data-label="Invitation / commitment"><div className={styles.splitEvidence}><div className={styles.evidenceCell}><span className={styles.layerLabel}>Delivery evidence</span><span className={styles.status}>{record.invitation.state}</span><span className={styles.muted}>{record.invitation.deliveryEvidence.deliveryState} · simulated delivery evidence</span></div><div className={styles.evidenceCell}><span className={styles.layerLabel}>Commitment truth</span><span className={accepted ? styles.statusGood : styles.statusWarn}>{record.assignment.commitment.state}</span>{record.assignment.commitment.respondedAt ? <span className={styles.muted}>{record.assignment.commitment.respondedAt}</span> : <span className={styles.muted}>No response recorded</span>}</div></div></td>
    <td data-label="Tasks / readiness"><div className={styles.splitEvidence}><div className={styles.evidenceCell}><span className={styles.layerLabel}>Required tasks</span><strong>{completedRequiredTaskCount} / {requiredTaskCount} complete</strong><span className={styles.muted}>{pendingTask ? `${pendingTask.title} · ${pendingTask.dueState.toLowerCase().replaceAll("_", " ")}` : "No required task pending"}</span></div><div className={styles.evidenceCell}><span className={styles.layerLabel}>Deterministic gates</span><span className={record.readiness.eligible ? styles.statusGood : styles.statusWarn}>{record.readiness.eligible ? "Ready" : "Blocked"}</span><span className={styles.muted}>{blockedGates.length} gate(s) blocked</span></div></div></td>
    <td data-label="Organizer actions"><div className={styles.rowActions}>
      <form action={sendSpeakerInvitation}><input type="hidden" name="workspace" value={workspace} /><input type="hidden" name="eventId" value={eventId} /><input type="hidden" name="personId" value={record.person.personId} /><input type="hidden" name="idempotencyKey" value={`invitation:${record.invitation.id}:${record.communications.length}`} /><button className={styles.secondaryButton} type="submit">{record.invitation.state === "RESPONDED" ? "Resend invitation evidence" : "Send invitation"}</button></form>
      <form action={openSyntheticSpeakerPortalPreview}><input type="hidden" name="workspace" value={workspace} /><input type="hidden" name="eventId" value={eventId} /><input type="hidden" name="personId" value={record.person.personId} /><button className={styles.secondaryButton} type="submit">Open local preview</button></form>
      {pendingActionTask ? <span className={styles.muted}>Due reminders for this shared ACTION assignment are queued from the durable scheduler.</span> : null}
    </div></td>
    <td data-label="Evidence / history"><div className={styles.rowEvidence}>
      <details className={styles.details}><summary>Profile, session, and task controls</summary>
        <div className={styles.detailStack}>
          <WorkflowStatusControl workspace={workspace} eventId={eventId} record={record} />
          {profileTask ? <form action={saveOrganizerSpeakerProfile} className={styles.editorForm}><h4>Edit speaker profile metadata</h4><input type="hidden" name="workspace" value={workspace} /><input type="hidden" name="eventId" value={eventId} /><input type="hidden" name="personId" value={record.person.personId} /><input type="hidden" name="taskId" value={profileTask.id} /><input type="hidden" name="idempotencyKey" value={`organizer-profile:${profileTask.id}:${profileTask.submissionVersionId ?? "baseline"}`} /><label>Bio<textarea name="bio" defaultValue={profile.bio} maxLength={12000} required /></label><div className={styles.inlineFields}><label>Public title<input name="publicTitle" defaultValue={profile.publicTitle} maxLength={240} required /></label><label>Organization<input name="organization" defaultValue={profile.organization} maxLength={240} required /></label></div><label>Social links JSON<input name="socialLinksJson" defaultValue={JSON.stringify(profile.socialLinks)} maxLength={16000} required /></label><p className={styles.muted}>Real headshot versions appear in artifact history and remain immutable.</p><button className={styles.primaryButton} type="submit">Save profile revision</button></form> : null}
          <SessionContentEditor workspace={workspace} eventId={eventId} record={record} />
          <TaskControls workspace={workspace} eventId={eventId} record={record} />
        </div>
      </details>
      <details className={styles.details}><summary>Exact assignment and delivery evidence</summary><dl className={styles.evidenceGrid}><div><dt>Source plan</dt><dd><code>{record.assignment.sourcePlanVersionId}</code></dd></div><div><dt>Assignment</dt><dd><code>{record.assignment.sourcePlanAssignmentId}</code></dd></div><div><dt>Offer</dt><dd><code>{record.assignment.commitment.offerId}</code></dd></div><div><dt>Terms fingerprint</dt><dd><code>{record.assignment.commitment.offerTermsFingerprint}</code></dd></div><div><dt>Scheduled</dt><dd>{record.assignment.schedule.startsAt} · {record.assignment.schedule.timezone}</dd></div><div><dt>Readiness receipt</dt><dd><code>{record.readiness.computationFingerprint}</code></dd></div></dl><ArtifactBrowser workspace={workspace} eventId={eventId} personName={record.person.fullName} artifacts={artifacts} /></details>
      <details className={styles.details}><summary>Communication evidence ({record.communications.length})</summary>{record.communications.length === 0 ? <p className={styles.muted}>No communication evidence is recorded.</p> : <ul className={styles.compactList}>{record.communications.map((evidence) => <li key={evidence.id}><strong>{evidence.kind}</strong> · {evidence.deliveryState} · <time dateTime={evidence.occurredAt}>{evidence.occurredAt}</time><br /><span className={styles.muted}>{evidence.renderedPreview}</span></li>)}</ul>}</details>
    </div></td>
  </tr>;
}

function ManualSpeakerRow({ workspace, eventId, record, artifacts }: { readonly workspace: string; readonly eventId: string; readonly record: ManualSpeakerRecord; readonly artifacts: readonly SpeakerArtifactRecord[] | null }) {
  return <tr>
    <td data-label="Person"><div className={styles.personCell}><span className={styles.layerLabel}>Canonical Person · workspace authority</span><strong>{record.canonicalPerson.fullName}</strong><span className={styles.muted}>{record.canonicalPerson.email}</span><code>{record.personId}</code><span className={styles.layerLabel}>{record.managementState === "MANUAL_PROVENANCE" ? "Event-specific profile · manual provenance" : "Event-specific profile · provenance unavailable"}</span><span className={styles.muted}>{record.managementState === "MANUAL_PROVENANCE" ? `${record.eventProfile.title || "No title"} · ${record.eventProfile.organization || "No organization"}` : "No event-scoped manual profile evidence"}</span></div></td>
    <td data-label="Assignment / workflow"><div className={styles.evidenceCell}><span className={styles.layerLabel}>Event relationship</span><strong>{record.roleKey}</strong><span className={styles.muted}>{record.managementState === "MANUAL_PROVENANCE" ? "Organizer-managed speaker" : "Existing speaker relation; manual provenance is unverified"}</span><span className={styles.muted}>Added to event · participation {record.participationStatusTrust === "TRUSTED" ? record.participationStatus.toLowerCase() : "status unverified"}</span><span className={styles.layerLabel}>Organizer workflow</span><span className={styles.muted}>Available after a canonical accepted assignment.</span></div></td>
    <td data-label="Invitation / commitment"><div className={styles.splitEvidence}><div className={styles.evidenceCell}><span className={styles.layerLabel}>Delivery evidence</span><span className={record.deliveryEvidence.source === "durable-outbox" ? styles.status : styles.statusWarn}>{record.deliveryEvidence.state}</span>{record.deliveryEvidence.source === "durable-outbox" ? <span className={styles.muted}>Durable outbox evidence · {record.deliveryEvidence.messageIds.length} message(s)</span> : <span className={styles.muted}>{record.participationStatus === "INVITED" ? "Invitation relationship is recorded, but durable delivery evidence is not established." : "No durable invitation or delivery evidence is established."}</span>}</div><div className={styles.evidenceCell}><span className={styles.layerLabel}>Commitment truth</span><span className={styles.statusWarn}>Not recorded</span><span className={styles.muted}>Manual roster link is not a commitment.</span></div></div></td>
    <td data-label="Tasks / readiness"><div className={styles.splitEvidence}><div className={styles.evidenceCell}><span className={styles.layerLabel}>Task evidence</span><strong>No onboarding tasks</strong><span className={styles.muted}>No task assignment has been created.</span></div><div className={styles.evidenceCell}><span className={styles.layerLabel}>Deterministic gates</span><span className={styles.statusWarn}>Not evaluated</span><span className={styles.muted}>Readiness follows assignment and task evidence.</span></div></div></td>
    <td data-label="Organizer actions"><div className={styles.rowActions}><details className={styles.details}><summary>{record.managementState === "MANUAL_PROVENANCE" ? "Edit profile metadata" : "Establish manual profile provenance"}</summary><form action={editManualSpeaker} className={styles.editorForm}><input type="hidden" name="workspace" value={workspace} /><input type="hidden" name="eventId" value={eventId} /><input type="hidden" name="personId" value={record.personId} /><input type="hidden" name="expectedFullName" value={record.canonicalPerson.fullName} /><label>Canonical Person name<input name="fullName" defaultValue={record.canonicalPerson.fullName} maxLength={240} required /></label><label>Canonical email<input name="email" type="email" value={record.canonicalPerson.email} readOnly aria-readonly="true" /></label><p className={styles.manualSpeakerNote}>Canonical name and email are workspace-scoped. Canonical email is read-only after creation; changing the name updates this canonical Person across events. A stale form fails closed.</p><div className={styles.inlineFields}><label>Event-specific title<input name="title" defaultValue={record.eventProfile.title} maxLength={240} /></label><label>Event-specific organization / company<input name="organization" defaultValue={record.eventProfile.organization} maxLength={240} /></label></div><label>Event-specific bio<textarea name="bio" defaultValue={record.eventProfile.bio} maxLength={4_000} rows={4} /></label><p className={styles.manualSpeakerNote}>Title, organization, and bio are stored in this event's manual provenance and do not overwrite another event's projection.</p><button className={styles.primaryButton} type="submit">Save profile metadata</button></form></details><span className={styles.muted}>No portal until an invitation workflow creates one.</span></div></td>
    <td data-label="Evidence / history"><div className={styles.rowEvidence}><span className={styles.muted}>Event provenance v{record.provenance.sourceVersion ?? "—"} · {record.updatedAt}</span><ArtifactBrowser workspace={workspace} eventId={eventId} personName={record.fullName} artifacts={artifacts} /></div></td>
  </tr>;
}

function WorkflowStatusControl({ workspace, eventId, record }: { readonly workspace: string; readonly eventId: string; readonly record: SpeakerRosterRecord }) {
  return <div className={styles.statusControl}>
    <span className={styles.layerLabel}>Organizer workflow</span>
    <form action={updateSpeakerWorkflowStatus}>
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="personId" value={record.person.personId} />
      <input type="hidden" name="expectedCurrentStatus" value={record.workflowStatus} />
      <input type="hidden" name="expectedVersion" value={record.workflowStatusVersion ?? ""} />
      <input type="hidden" name="idempotencyKey" value={`workflow-status:${record.person.personId}:${record.workflowStatusVersion ?? "initial"}`} />
      <label className={styles.srOnly} htmlFor={`workflow-status-${record.person.personId}`}>Workflow status for {record.person.fullName}</label>
      <select id={`workflow-status-${record.person.personId}`} name="status" defaultValue={record.workflowStatus}>
        {SPEAKER_WORKFLOW_STATUSES.map((status) => <option key={status} value={status}>{workflowStatusLabel(status)}</option>)}
      </select>
      <button className={styles.secondaryButton} type="submit">Save status</button>
    </form>
    <span className={styles.muted}>Separate from commitment, tasks, readiness, and delivery evidence.</span>
  </div>;
}

function ArtifactBrowser({ workspace, eventId, personName, artifacts }: { readonly workspace: string; readonly eventId: string; readonly personName: string; readonly artifacts: readonly SpeakerArtifactRecord[] | null }) {
  if (artifacts === null) return <span className={styles.muted}>Artifact history is temporarily unavailable.</span>;
  const headshot = artifacts.filter((artifact) => artifact.kind === "HEADSHOT").at(-1);
  if (artifacts.length === 0) return <span className={styles.muted}>No real files uploaded</span>;
  return <div className={styles.artifactBrowser}><span className={styles.layerLabel}>Real artifact versions</span>{headshot ? <img className={styles.headshotPreview} src={`/w/${workspace}/events/${eventId}/speakers/artifacts/${headshot.artifactId}`} alt={`${personName} headshot`} /> : null}<ul className={styles.artifactList}>{artifacts.map((artifact) => <li key={artifact.artifactId}><a href={`/w/${workspace}/events/${eventId}/speakers/artifacts/${artifact.artifactId}`}>{artifact.displayFilename}</a> · v{artifact.version} · {formatBytes(artifact.byteSize)}{artifact.current ? " · current" : " · superseded"}</li>)}</ul></div>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function TaskRequestPanel({ workspace, projection }: { readonly workspace: string; readonly projection: SpeakerOrganizerProjection }) {
  return <section className={styles.panel} aria-labelledby="task-request-title">
    <div className={styles.panelHeader}><div><p className={styles.eyebrow}>Content and task management</p><h2 id="task-request-title">Create an individual speaker task</h2></div><span className={styles.muted}>Linked to a canonical Person and assignment</span></div>
    {projection.roster.length === 0 ? <p className={styles.empty}>No assigned speakers are available in this view. Clear the roster filters or create an accepted assignment before creating an individual task.</p> : <form action={createSpeakerTask} className={styles.editorForm}><input type="hidden" name="workspace" value={workspace} /><input type="hidden" name="eventId" value={projection.event.id} /><input type="hidden" name="idempotencyKey" value={`create-task:${projection.asOf}`} /><div className={styles.inlineFields}><label>Speaker<select name="personId" defaultValue={projection.roster[0]?.person.personId} required>{projection.roster.map((record) => <option key={record.person.personId} value={record.person.personId}>{record.person.fullName} · {record.role}</option>)}</select></label><label>Request type<select name="taskTemplate" defaultValue="SLIDES" required>{ORGANIZER_SPEAKER_TASK_TEMPLATES.map((template) => <option key={template.value} value={template.value}>{template.label}</option>)}</select></label></div><div className={styles.inlineFields}><label>Title<input name="title" defaultValue="Supporting asset request" maxLength={240} required /></label><label>Due date (UTC)<input name="dueAt" type="datetime-local" defaultValue="2026-09-10T17:00" required /></label><label>Gate<select name="gate" defaultValue="OPERATOR_RELEASE"><option value="">No readiness gate</option><option value="CONFIRMATION">Confirmation</option><option value="PUBLICATION">Publication</option><option value="OPERATOR_RELEASE">Operator release</option></select></label></div><label>Instructions<textarea name="description" defaultValue="Upload a bounded PNG or PDF through the speaker portal. Each upload remains an immutable artifact version." maxLength={1200} required /></label><label className={styles.checkLabel}><input type="checkbox" name="required" value="true" defaultChecked /> Required for readiness</label><button className={styles.primaryButton} type="submit">Create task and assign speaker</button></form>}
  </section>;
}

function SpeakerDeliverables({ workspace, projection }: { readonly workspace: string; readonly projection: SpeakerOrganizerProjection }) {
  const priority = (task: SpeakerTaskProjection): number => {
    if (task.state === "BLOCKED" || task.state === "CHANGES_REQUESTED") return 0;
    if (task.dueState === "OVERDUE") return 1;
    if (task.review && task.review.versions.length > 0 && task.review.latestReviewState !== "APPROVED") return 2;
    if (task.dueState === "DUE_SOON") return 3;
    return 4;
  };
  const deliverables = projection.roster
    .flatMap((record) => record.tasks.map((task) => ({ record, task, version: task.review?.versions.at(-1) ?? null })))
    .sort((left, right) => priority(left.task) - priority(right.task) || left.task.dueAt.localeCompare(right.task.dueAt));
  return <section id="speaker-deliverables-work" className={`${styles.panel} ${styles.workPanel}`} aria-labelledby="deliverables-title">
    <div className={styles.panelHeader}><div><p className={styles.eyebrow}>Routine work · priority ordered</p><h2 id="deliverables-title">Deliverables work queue</h2></div><span className={styles.badge}>{deliverables.length} task{deliverables.length === 1 ? "" : "s"}</span></div>
    <form id={`content-export-${projection.event.id}`} method="get" action={`/w/${workspace}/events/${projection.event.id}/speakers/content/export`} className={styles.exportForm}><p className={styles.muted}>Select versions for a metadata-only export. Previous immutable versions remain available in history.</p><button className={styles.secondaryButton} type="submit">Download selected content metadata</button><a className={styles.secondaryButton} href={`/w/${workspace}/events/${projection.event.id}/speakers/content/export`}>Download all content metadata</a></form>
    {deliverables.length === 0 ? <p className={styles.empty}>No speaker tasks match the current authorized roster filters.</p> : <div className={styles.tableWrap} role="region" aria-label="Speaker deliverables work queue table" tabIndex={0}><table className={`${styles.table} ${styles.deliverablesTable}`}><caption>Per-speaker task state, deadline, exact version, and file metadata</caption><thead><tr><th scope="col">Select</th><th scope="col">Speaker / task</th><th scope="col">State / due</th><th scope="col">Exact version</th><th scope="col">Asset metadata</th></tr></thead><tbody>{deliverables.map(({ record, task, version }) => { const payload = version?.payload; const asset = payload && (payload.kind === "HEADSHOT" || payload.kind === "SLIDES") ? payload.asset : payload?.kind === "PROFILE" ? payload.headshot : null; const taskNeedsAttention = priority(task) <= 2; return <tr key={task.id} className={taskNeedsAttention ? styles.attentionRow : undefined}><td>{version ? <input type="checkbox" name="versionId" value={version.id} form={`content-export-${projection.event.id}`} aria-label={`Select ${record.person.fullName} ${task.title} version ${version.version}`} /> : "—"}</td><td><strong>{record.person.fullName}</strong><br /><span className={styles.muted}>{record.role} · {task.title} · {task.required ? "Required" : "Optional"}</span></td><td><span className={task.state === "COMPLETED" ? styles.statusGood : task.state === "BLOCKED" || task.state === "CHANGES_REQUESTED" ? styles.statusWarn : styles.status}>{task.state}</span><br /><span className={task.dueState === "OVERDUE" ? styles.overdueText : styles.muted}><time dateTime={task.dueAt}>{task.dueAt}</time> · {task.dueState}</span><br /><span className={styles.muted}>Review: {task.review?.latestReviewState ?? "NOT_SUBMITTED"}</span></td><td>{version ? <><strong>v{version.version}</strong><br /><code>{version.contentHash}</code></> : "No submission"}</td><td>{asset ? <><strong>{asset.fileName}</strong><br /><span className={styles.muted}>{asset.mediaType} · {asset.byteSize} bytes declared metadata</span></> : <span className={styles.muted}>No file metadata</span>}</td></tr>; })}</tbody></table></div>}
    <p className={styles.muted}>This export remains metadata-only. Authenticated PNG/PDF bytes and immutable versions are listed in each roster row when present.</p>
  </section>;
}

function SessionContentEditor({ workspace, eventId, record }: { readonly workspace: string; readonly eventId: string; readonly record: SpeakerRosterRecord }) {
  const titleTask = record.tasks.find((task) => task.contentKind === "SESSION_TITLE");
  const descriptionTask = record.tasks.find((task) => task.contentKind === "SESSION_DESCRIPTION");
  const titlePayload = titleTask?.review?.versions.at(-1)?.payload;
  const descriptionPayload = descriptionTask?.review?.versions.at(-1)?.payload;
  return <div className={styles.editorForm}><h4>Edit session content</h4>{titleTask ? <form action={saveOrganizerSessionContent}><input type="hidden" name="workspace" value={workspace} /><input type="hidden" name="eventId" value={eventId} /><input type="hidden" name="personId" value={record.person.personId} /><input type="hidden" name="taskId" value={titleTask.id} /><input type="hidden" name="contentKind" value="SESSION_TITLE" /><input type="hidden" name="idempotencyKey" value={`organizer-title:${titleTask.id}:${titleTask.submissionVersionId ?? "baseline"}`} /><label>Session title<input name="title" defaultValue={titlePayload?.kind === "SESSION_TITLE" ? titlePayload.title : record.assignment.programUnitName} maxLength={240} required /></label><button className={styles.secondaryButton} type="submit">Save session title version</button></form> : null}{descriptionTask ? <form action={saveOrganizerSessionContent}><input type="hidden" name="workspace" value={workspace} /><input type="hidden" name="eventId" value={eventId} /><input type="hidden" name="personId" value={record.person.personId} /><input type="hidden" name="taskId" value={descriptionTask.id} /><input type="hidden" name="contentKind" value="SESSION_DESCRIPTION" /><input type="hidden" name="idempotencyKey" value={`organizer-description:${descriptionTask.id}:${descriptionTask.submissionVersionId ?? "baseline"}`} /><label>Session abstract / description<textarea name="description" defaultValue={descriptionPayload?.kind === "SESSION_DESCRIPTION" ? descriptionPayload.description : ""} maxLength={12000} required /></label><button className={styles.secondaryButton} type="submit">Save abstract version</button></form> : null}<p className={styles.muted}>Organizer edits are attributed immutable content versions and remain separate from the approved schedule decision.</p></div>;
}

function TaskControls({ workspace, eventId, record }: { readonly workspace: string; readonly eventId: string; readonly record: SpeakerRosterRecord }) {
  return <div className={styles.editorForm}><h4>Task deadline and state controls</h4>{record.tasks.map((task) => task.kind === "ACTION" ? <div className={styles.taskControl} key={task.id}><strong>{task.title}</strong><span className={styles.muted}>Immutable shared definition · due {task.dueAt} · speaker status {task.state}</span></div> : <form action={updateSpeakerTask} className={styles.taskControl} key={task.id}><input type="hidden" name="workspace" value={workspace} /><input type="hidden" name="eventId" value={eventId} /><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="idempotencyKey" value={`task-control:${task.id}:${task.dueAt}:${task.state}`} /><strong>{task.title}</strong><label>Due (UTC)<input name="dueAt" type="datetime-local" defaultValue={dateInputValue(task.dueAt)} required /></label>{task.contentKind ? <span className={styles.muted}>State follows exact content review: {task.state}</span> : <label>State<select name="state" defaultValue={task.state}><option value="NOT_STARTED">Not started</option><option value="IN_PROGRESS">In progress</option><option value="SUBMITTED">Submitted</option><option value="CHANGES_REQUESTED">Changes requested</option><option value="COMPLETED">Completed</option><option value="BLOCKED">Blocked</option></select></label>}<button className={styles.secondaryButton} type="submit">Save task control</button></form>)}</div>;
}

function dateInputValue(value: string): string {
  return value.length >= 16 ? value.slice(0, 16) : value;
}

function workflowStatusLabel(status: SpeakerWorkflowStatus): string {
  return status === "IN_PROGRESS" ? "In progress" : status === "ON_HOLD" ? "On hold" : status === "NEW" ? "New" : status === "READY" ? "Ready" : "Completed";
}

export function SpeakerReviewQueue({ workspace, projection }: { readonly workspace: string; readonly projection: SpeakerOrganizerProjection }) {
  const reviewPriority = (task: SpeakerTaskProjection): number => {
    const state = task.review?.latestReviewState;
    if (state === "BLOCKED") return 0;
    if (state === "CHANGES_REQUESTED") return 1;
    if (state === "SUBMITTED" || state === "IN_REVIEW") return 2;
    return 3;
  };
  const submitted = projection.roster
    .flatMap((record) => record.tasks.flatMap((task) => task.review && task.review.versions.length > 0 ? [{ record, task }] : []))
    .sort((left, right) => reviewPriority(left.task) - reviewPriority(right.task));
  const pendingReviewCount = submitted.filter(({ task }) => task.review?.latestReviewState !== "APPROVED").length;
  return <section className={`${styles.panel} ${styles.reviewQueue}`} aria-labelledby="content-review-title">
    <div className={styles.panelHeader}><div><p className={styles.eyebrow}>Exact-version review · priority ordered</p><h2 id="content-review-title">Content submissions and approvals</h2><p className={styles.muted}>Current review work stays open; payloads, prior versions, findings, comments, and approval receipts expand in place.</p></div><span className={pendingReviewCount > 0 ? styles.statusWarn : styles.statusGood}>{pendingReviewCount} need review</span></div>
    {submitted.length === 0 ? <p className={styles.empty}>No content versions have been submitted.</p> : <div className={styles.reviewList}>{submitted.map(({ record, task }) => <ContentReviewCard key={`${record.person.personId}-${task.id}`} workspace={workspace} record={record} task={task} eventId={projection.event.id} />)}</div>}
  </section>;
}

function ContentReviewCard({ workspace, record, task, eventId }: { readonly workspace: string; readonly record: SpeakerRosterRecord; readonly task: SpeakerTaskProjection; readonly eventId: string }) {
  const review = task.review!;
  const latestVersion = review.versions.find((version) => version.id === review.latestVersionId) ?? review.versions.at(-1);
  const requiresReview = review.latestReviewState !== "APPROVED";
  return <article className={`${styles.reviewCard} ${requiresReview ? styles.reviewAttention : ""}`}><header><div><h3>{record.person.fullName} · {task.title}</h3><p className={styles.muted}>{latestVersion ? `Latest immutable submission: version ${latestVersion.version}.` : "No latest submission is available."} Approval and revision actions remain bound to one exact content hash.</p></div><span className={requiresReview ? styles.statusWarn : styles.statusGood}>{review.latestReviewState}</span></header><ol className={styles.versionHistory}>{review.versions.map((version) => { const latest = version.id === review.latestVersionId; const approvals = review.approvals.filter((approval) => approval.submissionVersionId === version.id && approval.submissionContentHash === version.contentHash); const findings = review.findings.filter((finding) => finding.submissionVersionId === version.id); const comments = review.comments.filter((comment) => comment.submissionVersionId === version.id); const hidden = <><input type="hidden" name="workspace" value={workspace} /><input type="hidden" name="eventId" value={eventId} /><input type="hidden" name="personId" value={record.person.personId} /><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="submissionVersionId" value={version.id} /><input type="hidden" name="submissionContentHash" value={version.contentHash} /></>; return <li key={version.id} className={styles.versionRow}><details className={styles.versionDisclosure} open={latest}><summary><span><strong>Version {version.version}</strong><small>Submitted {version.submittedAt} by {version.submittedByKind}</small><code>{version.contentHash}</code></span><span className={styles.versionState}><span className={latest ? styles.statusGood : styles.badge}>{latest ? "Latest" : "History"}</span><span className={styles.badge}>{version.reviewState}</span></span></summary><div className={styles.versionBody}><div className={styles.versionToolbar}><a className={styles.secondaryButton} href={`/w/${workspace}/events/${eventId}/speakers/content/export?versionId=${encodeURIComponent(version.id)}`}>Download metadata</a><span className={styles.muted}>Exact version ID · <code>{version.id}</code></span></div><details className={styles.payloadDisclosure}><summary>Structured submission payload</summary><p className={styles.reviewPayload}>{JSON.stringify(version.payload)}</p></details><div className={styles.approvalEvidence}><span className={styles.layerLabel}>Approval evidence</span>{approvals.length === 0 ? <p className={styles.muted}>No approval decision is recorded for this exact version and content hash.</p> : <dl className={styles.evidenceGrid}>{approvals.map((approval) => <div key={`${approval.submissionVersionId}-${approval.gate}`}><dt>{approval.gate}</dt><dd>Approved by {approval.approvedBy} · <time dateTime={approval.approvedAt}>{approval.approvedAt}</time></dd></div>)}</dl>}</div>{findings.map((finding) => <p className={styles.finding} key={finding.id}><strong>{finding.severity}</strong> · {finding.message}</p>)}{comments.map((comment) => <p className={styles.comment} key={comment.id}>Comment · {comment.body} <span className={styles.muted}>({comment.authorKind} · {comment.createdAt})</span></p>)}<div className={styles.actionGrid}>{latest ? <><form action={approveSpeakerContent}>{hidden}<input type="hidden" name="gate" value="PUBLICATION" /><input type="hidden" name="idempotencyKey" value={`approve:${version.id}`} /><button className={styles.primaryButton} type="submit" disabled={version.reviewState === "APPROVED"}>Approve exact version</button></form><form action={requestSpeakerRevision}>{hidden}<input type="hidden" name="reason" value="Please revise this exact content version before publication." /><input type="hidden" name="idempotencyKey" value={`revision:${version.id}`} /><button className={styles.secondaryButton} type="submit">Request revision</button></form><form action={addSpeakerFinding}>{hidden}<input type="hidden" name="severity" value="BLOCKER" /><input type="hidden" name="message" value="Organizer review requires a follow-up on this exact version." /><input type="hidden" name="blocksReadiness" value="true" /><input type="hidden" name="idempotencyKey" value={`finding:${version.id}`} /><button className={styles.dangerButton} type="submit">Add blocker finding</button></form><form action={addSpeakerComment}>{hidden}<label className={styles.commentLabel}>Comment <input name="body" defaultValue="Review note: " /><input type="hidden" name="idempotencyKey" value={`comment:${version.id}`} /></label><button className={styles.secondaryButton} type="submit">Add comment</button></form></> : <form action={restoreSpeakerContent}>{hidden}<input type="hidden" name="idempotencyKey" value={`restore:${version.id}:${review.latestVersionId ?? "none"}`} /><button className={styles.secondaryButton} type="submit">Restore as new version</button></form>}</div></div></details></li>; })}</ol><p className={styles.muted}>Version history, review comments, findings, and approvals remain visible to the authorized organizer and scoped speaker; restored content creates a new version.</p></article>;
}
