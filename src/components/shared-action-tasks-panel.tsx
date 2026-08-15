"use client";

import { useActionState, useMemo, useState } from "react";

import {
  createSharedActionTaskAction,
  queueActionTaskRemindersAction,
  type CreateSharedActionTaskActionState,
  type QueueActionTaskRemindersActionState,
  type SharedActionTasksSurface,
} from "@/app/w/[workspace]/events/[eventId]/speakers/actions";
import type { SharedActionTaskReminderDelivery } from "@/server/services/speaker-operations";

import styles from "./speaker-communications-panel.module.css";

const IDLE_CREATE: CreateSharedActionTaskActionState = { kind: "idle" };
const IDLE_REMINDERS: QueueActionTaskRemindersActionState = { kind: "idle" };

export function SharedActionTasksPanel({ surface }: { readonly surface: SharedActionTasksSurface }) {
  const [createState, createAction, creating] = useActionState<CreateSharedActionTaskActionState, FormData>(
    createSharedActionTaskAction,
    IDLE_CREATE,
  );
  const [reminderState, reminderAction, queueing] = useActionState<QueueActionTaskRemindersActionState, FormData>(
    queueActionTaskRemindersAction,
    IDLE_REMINDERS,
  );
  const boundedDefaultSelection = useMemo(
    () => surface.speakers.slice(0, surface.maximumAssignees).map((speaker) => speaker.personId),
    [surface.maximumAssignees, surface.speakers],
  );
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set(boundedDefaultSelection));
  const selectedCount = useMemo(
    () => surface.speakers.filter((speaker) => selectedIds.has(speaker.personId)).length,
    [selectedIds, surface.speakers],
  );

  function toggleSpeaker(personId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(personId)) next.delete(personId);
      else {
        const currentSpeakerIds = new Set(surface.speakers.map((speaker) => speaker.personId));
        const currentSelectionSize = [...next].filter((selectedId) => currentSpeakerIds.has(selectedId)).length;
        if (currentSelectionSize < surface.maximumAssignees) next.add(personId);
      }
      return next;
    });
  }

  return (
    <section className={styles.panel} aria-labelledby="shared-action-tasks-title" data-testid="shared-action-tasks-panel">
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>Shared speaker work</p>
          <h2 id="shared-action-tasks-title">General ACTION tasks</h2>
          <p className={styles.lede}>Create one immutable task definition and atomically assign an independent completion record to at least two current speakers.</p>
        </div>
        <span className={styles.localBadge}>Durable task evidence</span>
      </header>

      <div className={styles.boundaryNotice} role="note">
        <strong>Due dates are date-only UTC.</strong>
        <span>The assignment remains due through 23:59:59.999 UTC on the chosen date. Title, instructions, due date, and assignees are immutable; each assignment status changes independently.</span>
      </div>

      <form action={createAction} className={styles.form} data-testid="shared-action-task-form">
        <input type="hidden" name="workspace" value={surface.workspace} />
        <input type="hidden" name="eventId" value={surface.event.id} />
        <input type="hidden" name="idempotencyKey" value={surface.nextIdempotencyKey} />
        <div className={styles.editorGrid}>
          <section className={styles.audience} aria-labelledby="shared-action-task-assignees-title">
            <div className={styles.sectionHeading}>
              <div><p className={styles.kicker}>Current event authority</p><h3 id="shared-action-task-assignees-title">Assignees</h3></div>
              <span className={styles.count}>{selectedCount} selected · {surface.speakers.length} current · maximum {surface.maximumAssignees}</span>
            </div>
            <p className={styles.help}>The command re-checks the current approved plan, accepted offer, event role, workspace, and Person for every selection before writing anything.</p>
            <div className={styles.selectionActions}>
              <button type="button" className={styles.textButton} onClick={() => setSelectedIds(new Set(boundedDefaultSelection))} disabled={surface.speakers.length === 0}>Select up to {surface.maximumAssignees}</button>
              <button type="button" className={styles.textButton} onClick={() => setSelectedIds(new Set())} disabled={selectedCount === 0}>Clear</button>
            </div>
            {surface.speakers.length === 0 ? <p className={styles.empty}>No current accepted speakers are available for this event.</p> : <ul className={styles.recipientList}>{surface.speakers.map((speaker) => <li className={styles.recipientRow} key={speaker.personId}><label><input type="checkbox" name="personId" value={speaker.personId} checked={selectedIds.has(speaker.personId)} disabled={!selectedIds.has(speaker.personId) && selectedCount >= surface.maximumAssignees} onChange={() => toggleSpeaker(speaker.personId)} /><span className={styles.recipientCopy}><strong>{speaker.fullName}</strong><span>{speaker.role}</span><small>Person {speaker.personId} · assignment {speaker.assignmentId}</small></span></label></li>)}</ul>}
          </section>

          <section className={styles.composer} aria-labelledby="shared-action-task-definition-title">
            <div className={styles.sectionHeading}><div><p className={styles.kicker}>Immutable definition</p><h3 id="shared-action-task-definition-title">Task details</h3></div><span className={styles.count}>ACTION · required</span></div>
            <label className={styles.field}>Title<input name="title" maxLength={240} required /></label>
            <label className={styles.field}>Instructions<textarea name="instructions" maxLength={surface.maximumInstructions} rows={7} required /></label>
            <label className={styles.field}>Due date (UTC)<input name="dueDate" type="date" min={surface.minimumDueDate} max={surface.maximumDueDate} defaultValue={surface.defaultDueDate} required /></label>
            <p className={styles.help}>One command writes all assignments or none. Replaying this exact request is safe; reusing its key with different content conflicts.</p>
          </section>
        </div>
        {createState.kind === "error" ? <div className={styles.error} role="alert" data-testid="shared-action-task-error"><strong>{createState.message}</strong><span>No shared ACTION task was acknowledged.</span></div> : null}
        {createState.kind === "success" ? <div className={styles.success} role="status" aria-live="polite" data-testid="shared-action-task-success"><strong>{createState.message}</strong><span>Definition {createState.receipt.definitionId} · due {createState.receipt.dueDate} UTC · {createState.revalidated ? "projection refreshed" : "reload to refresh the projection"}.</span></div> : null}
        <div className={styles.submitRow}>
          <span className={styles.submitHint}>{selectedCount < surface.minimumAssignees ? `Select at least ${surface.minimumAssignees} current speakers.` : `${selectedCount} independent assignment records will commit together (maximum ${surface.maximumAssignees}).`}</span>
          <button className={styles.primaryButton} type="submit" disabled={creating || selectedCount < surface.minimumAssignees}>{creating ? "Creating atomically…" : `Create for ${selectedCount} speakers`}</button>
        </div>
      </form>

      <TaskHistory surface={surface} />

      <section className={styles.composer} aria-labelledby="action-task-reminder-title" data-testid="action-task-reminder-scheduler">
        <div className={styles.sectionHeading}>
          <div><p className={styles.kicker}>Organizer-triggered scheduler</p><h3 id="action-task-reminder-title">Queue due-date reminders</h3></div>
          <span className={styles.localBadge}>PENDING outbox only</span>
        </div>
        <div className={styles.boundaryNotice} role="note" data-testid="action-task-reminder-provider-boundary">
          <strong>No SMTP or provider is contacted.</strong>
          <span>Each UTC-day occurrence includes incomplete overdue ACTION assignments and incomplete assignments due before the exclusive seven-day upper boundary. Completed, later-due, wrong-event, and non-current speakers are skipped. A trigger scans at most {surface.maximumReminderAssignments} assignments and fails without queueing rows if that bound is exceeded.</span>
        </div>
        <form action={reminderAction} className={styles.form}>
          <input type="hidden" name="workspace" value={surface.workspace} />
          <input type="hidden" name="eventId" value={surface.event.id} />
          {reminderState.kind === "error" ? <div className={styles.error} role="alert" data-testid="action-task-reminder-error"><strong>{reminderState.message}</strong><span>No reminder queue receipt was acknowledged.</span></div> : null}
          {reminderState.kind === "success" ? <div className={styles.success} role="status" aria-live="polite" data-testid="action-task-reminder-success"><strong>{reminderState.message}</strong><span>Scanned {reminderState.receipt.scannedCount} · already queued {reminderState.receipt.alreadyQueuedCount} · completed {reminderState.receipt.completedCount} · not due {reminderState.receipt.notDueCount} · non-current {reminderState.receipt.nonCurrentSpeakerCount} · window ends before {reminderState.receipt.windowEndExclusive}.</span></div> : null}
          <div className={styles.submitRow}>
            <span className={styles.submitHint}>Repeat triggers preserve existing status and attempts; they do not create a second message for the same recipient, task, and occurrence.</span>
            <button className={styles.primaryButton} type="submit" disabled={queueing}>{queueing ? "Scanning and queueing…" : "Queue due reminders"}</button>
          </div>
        </form>
      </section>

      <ReminderHistory reminders={surface.reminders} />
    </section>
  );
}

function TaskHistory({ surface }: { readonly surface: SharedActionTasksSurface }) {
  return <section className={styles.history} aria-labelledby="shared-action-task-history-title" data-testid="shared-action-task-history"><div className={styles.sectionHeading}><div><p className={styles.kicker}>Durable organizer projection</p><h3 id="shared-action-task-history-title">Shared task status</h3></div><span className={styles.count}>{surface.batches.length} definition{surface.batches.length === 1 ? "" : "s"}</span></div>{surface.batches.length === 0 ? <p className={styles.empty}>No shared ACTION tasks have been created for this event.</p> : surface.batches.map((batch) => <div className={styles.historyTableWrap} key={batch.definitionId} data-testid={`shared-action-task-${batch.definitionId}`}><table className={styles.historyTable}><caption><strong>{batch.title}</strong> · {batch.completedCount}/{batch.assignmentCount} complete · due {batch.dueDate} UTC · definition {batch.definitionId}</caption><thead><tr><th scope="col">Speaker</th><th scope="col">Assignment</th><th scope="col">Status</th><th scope="col">Immutable definition</th></tr></thead><tbody>{batch.assignments.map((assignment) => <tr key={assignment.taskId}><td><strong>{assignment.speakerName}</strong><span className={styles.tableDetail}>Person {assignment.personId}</span></td><td><code>{assignment.taskId}</code><span className={styles.tableDetail}>Assignment {assignment.assignmentId}</span></td><td><span className={styles.status}>{assignment.state}</span></td><td><details><summary>{batch.title}</summary><pre>{batch.instructions}</pre><span className={styles.tableDetail}>Due through {batch.dueAt}</span></details></td></tr>)}</tbody></table></div>)}</section>;
}

function ReminderHistory({ reminders }: { readonly reminders: readonly SharedActionTaskReminderDelivery[] }) {
  return <section className={styles.history} aria-labelledby="action-task-reminder-history-title" data-testid="action-task-reminder-history"><div className={styles.sectionHeading}><div><p className={styles.kicker}>Durable task-recipient evidence</p><h3 id="action-task-reminder-history-title">Reminder outbox</h3></div><span className={styles.count}>{reminders.length} message row{reminders.length === 1 ? "" : "s"}</span></div>{reminders.length === 0 ? <p className={styles.empty}>No due-date reminder messages have been queued for this event.</p> : <div className={styles.historyTableWrap}><table className={styles.historyTable}><caption>Persisted Person/task IDs and actual outbox state; names and email addresses are the current canonical organizer projection. Queueing is not a delivery claim.</caption><thead><tr><th scope="col">Recipient identity</th><th scope="col">Task merge values</th><th scope="col">Outbox status</th><th scope="col">Occurrence</th></tr></thead><tbody>{reminders.map((reminder) => <ReminderRow reminder={reminder} key={reminder.messageId} />)}</tbody></table></div>}</section>;
}

function ReminderRow({ reminder }: { readonly reminder: SharedActionTaskReminderDelivery }) {
  return <tr><td><strong>{reminder.recipientName}</strong><span className={styles.tableDetail}>{reminder.recipientEmail} · current canonical display</span><span className={styles.tableDetail}>Durable recipient Person {reminder.recipientPersonId}</span></td><td><details><summary>{reminder.subjectPreview}</summary><pre>{reminder.bodyPreview}</pre><span className={styles.tableDetail}>Event {reminder.eventName} · task {reminder.taskId} · due {reminder.dueDate} UTC</span></details></td><td><span className={styles.status} data-state={reminder.status}>{reminder.status}</span><span className={styles.tableDetail}>Attempts {reminder.attemptCount} · provider mutation false</span><span className={styles.tableDetail}>{reminder.lastErrorRecorded ? "Failure detail recorded" : "No failure recorded"}</span></td><td><time dateTime={reminder.createdAt}>{reminder.createdAt}</time><span className={styles.tableDetail}>{reminder.occurrenceDate} · message {reminder.messageId}</span><span className={styles.tableDetail}>Local queue only · no provider contacted</span></td></tr>;
}
