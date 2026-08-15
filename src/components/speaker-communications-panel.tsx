"use client";

import { useActionState, useMemo, useState } from "react";

import {
  queueSpeakerCommunicationsAction,
  type SpeakerCommunicationsActionState,
  type SpeakerCommunicationsRecipient,
  type SpeakerCommunicationsSurface,
} from "@/app/w/[workspace]/events/[eventId]/speakers/communications/actions";
import type { SpeakerCommunicationDeliveryLogEntry } from "@/server/services/speaker-communications";

import styles from "./speaker-communications-panel.module.css";

const DEFAULT_SUBJECT = "Update for {{eventName}}";
const DEFAULT_BODY = "Hi {{firstName}},\n\nWe are preparing {{eventName}} and wanted to share an update.\n\nBest,\nThe organizing team";
const PLACEHOLDERS = ["{{displayName}}", "{{firstName}}", "{{organization}}", "{{title}}", "{{eventName}}"] as const;
const TEMPLATE_PATTERN = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu;
const IDLE_SPEAKER_COMMUNICATIONS_ACTION: SpeakerCommunicationsActionState = { kind: "idle" };

export function SpeakerCommunicationsPanel({ surface }: { readonly surface: SpeakerCommunicationsSurface }) {
  const [state, formAction, pending] = useActionState<SpeakerCommunicationsActionState, FormData>(
    queueSpeakerCommunicationsAction,
    IDLE_SPEAKER_COMMUNICATIONS_ACTION,
  );
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(surface.recipients.map((recipient) => recipient.personId)),
  );
  const [subjectTemplate, setSubjectTemplate] = useState(DEFAULT_SUBJECT);
  const [bodyTemplate, setBodyTemplate] = useState(DEFAULT_BODY);
  const selectedRecipients = useMemo(
    () => surface.recipients.filter((recipient) => selectedIds.has(recipient.personId)),
    [selectedIds, surface.recipients],
  );
  const previewRecipient = selectedRecipients[0] ?? null;

  function toggleRecipient(personId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  function selectAll(): void {
    setSelectedIds(new Set(surface.recipients.map((recipient) => recipient.personId)));
  }

  function clearAll(): void {
    setSelectedIds(new Set());
  }

  return (
    <section className={styles.panel} aria-labelledby="speaker-communications-title" data-testid="speaker-communications-panel">
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>Operational message queue</p>
          <h2 id="speaker-communications-title">Speaker communications</h2>
          <p className={styles.lede}>Resolve an event-scoped speaker audience, review the exact plain-text message, and queue a durable local batch.</p>
        </div>
        <span className={styles.localBadge}>Local outbox · no provider</span>
      </header>

      <div className={styles.boundaryNotice} role="note" data-testid="speaker-communications-provider-boundary">
        <strong>No email provider is connected.</strong>
        <span>This console writes PENDING outbox records only. It makes no network call and does not claim delivery.</span>
      </div>

      <form action={formAction} className={styles.form}>
        <input type="hidden" name="workspace" value={surface.workspace} />
        <input type="hidden" name="eventId" value={surface.event.id} />
        <input type="hidden" name="templateKey" value="speaker-bulk-local-v1" />
        <input type="hidden" name="idempotencyKey" value={surface.nextIdempotencyKey} />

        <div className={styles.editorGrid}>
          <section className={styles.audience} aria-labelledby="speaker-communications-audience-title" data-testid="speaker-communications-recipient-preview">
            <div className={styles.sectionHeading}>
              <div><p className={styles.kicker}>Event-scoped audience</p><h3 id="speaker-communications-audience-title">Resolved recipients</h3></div>
              <span className={styles.count}>{selectedRecipients.length} selected · {surface.recipients.length} available</span>
            </div>
            <p className={styles.help}>Names and destinations below were resolved from canonical People bound to this event. The action re-reads these records before queueing.</p>
            <div className={styles.selectionActions}>
              <button type="button" className={styles.textButton} onClick={selectAll} disabled={surface.recipients.length === 0}>Select all</button>
              <button type="button" className={styles.textButton} onClick={clearAll} disabled={selectedRecipients.length === 0}>Clear</button>
            </div>
            {surface.recipients.length === 0 ? <p className={styles.empty}>No event-scoped speakers are available for this message.</p> : <ul className={styles.recipientList}>{surface.recipients.map((recipient) => <RecipientOption key={recipient.personId} recipient={recipient} checked={selectedIds.has(recipient.personId)} onToggle={toggleRecipient} />)}</ul>}
          </section>

          <section className={styles.composer} aria-labelledby="speaker-communications-composer-title">
            <div className={styles.sectionHeading}><div><p className={styles.kicker}>Bounded plain text</p><h3 id="speaker-communications-composer-title">Message template</h3></div><span className={styles.count}>Subject 240 · body 12,000</span></div>
            <label className={styles.field}>Subject<input name="subjectTemplate" value={subjectTemplate} onChange={(event) => setSubjectTemplate(event.target.value)} maxLength={240} required /></label>
            <label className={styles.field}>Body<textarea name="bodyTemplate" value={bodyTemplate} onChange={(event) => setBodyTemplate(event.target.value)} maxLength={12000} rows={9} required /></label>
            <p className={styles.help}>Plain text only. Available merge fields: {PLACEHOLDERS.map((placeholder) => <code key={placeholder}>{placeholder}</code>)}</p>
            <Preview recipient={previewRecipient} eventName={surface.event.name} subjectTemplate={subjectTemplate} bodyTemplate={bodyTemplate} />
          </section>
        </div>

        {state.kind === "error" ? <div className={styles.error} role="alert" data-testid="speaker-communications-action-error"><strong>{state.message}</strong><span>No batch was acknowledged by this action.</span></div> : null}
        {state.kind === "success" ? <div className={styles.success} role="status" aria-live="polite" data-testid="speaker-communications-action-success"><strong>{state.message}</strong><span>Batch {state.receipt.batchId} · {state.receipt.messageIds.length} message row(s) · {state.revalidated ? "history refreshed" : "refresh the page to confirm history"}.</span></div> : null}
        <div className={styles.submitRow}>
          <span className={styles.submitHint}>{selectedRecipients.length === 0 ? "Select at least one recipient." : "The send button queues locally; it does not contact a provider."}</span>
          <button className={styles.primaryButton} type="submit" disabled={pending || selectedRecipients.length === 0}>{pending ? "Queueing…" : `Queue ${selectedRecipients.length} local message${selectedRecipients.length === 1 ? "" : "s"}`}</button>
        </div>
      </form>

      <DeliveryHistory history={surface.history} />
    </section>
  );
}

function RecipientOption({ recipient, checked, onToggle }: { readonly recipient: SpeakerCommunicationsRecipient; readonly checked: boolean; readonly onToggle: (personId: string) => void }) {
  return <li className={styles.recipientRow}><label><input type="checkbox" name="personId" value={recipient.personId} checked={checked} onChange={() => onToggle(recipient.personId)} /><span className={styles.recipientCopy}><strong>{recipient.displayName}</strong><span>{recipient.email}</span><small>{[recipient.title, recipient.organization, recipient.roles.join(" · ")].filter(Boolean).join(" · ") || "Event speaker"}</small></span></label></li>;
}

function mergeTemplate(template: string, recipient: SpeakerCommunicationsRecipient, eventName: string): string {
  const firstName = recipient.displayName.trim().split(/\s+/u, 1)[0] ?? recipient.displayName;
  const values: Record<string, string> = {
    displayName: recipient.displayName,
    firstName,
    organization: recipient.organization ?? "",
    title: recipient.title ?? "",
    eventName,
  };
  return template.replace(TEMPLATE_PATTERN, (_whole, name: string) => values[name] ?? "");
}

function Preview({ recipient, eventName, subjectTemplate, bodyTemplate }: { readonly recipient: SpeakerCommunicationsRecipient | null; readonly eventName: string; readonly subjectTemplate: string; readonly bodyTemplate: string }) {
  return <div className={styles.preview} aria-label="Rendered recipient preview"><div className={styles.previewHeading}><strong>Rendered preview</strong><span>{recipient ? `For ${recipient.displayName}` : "Select a recipient"}</span></div>{recipient ? <><p className={styles.previewSubject}>{mergeTemplate(subjectTemplate, recipient, eventName)}</p><pre>{mergeTemplate(bodyTemplate, recipient, eventName)}</pre></> : <p className={styles.help}>A recipient preview appears when an event-scoped Person is selected.</p>}</div>;
}

function DeliveryHistory({ history }: { readonly history: readonly SpeakerCommunicationDeliveryLogEntry[] }) {
  return <section className={styles.history} aria-labelledby="speaker-communications-history-title" data-testid="speaker-communications-history"><div className={styles.sectionHeading}><div><p className={styles.kicker}>Durable outbox evidence</p><h3 id="speaker-communications-history-title">Queue history</h3></div><span className={styles.count}>{history.length} message row{history.length === 1 ? "" : "s"}</span></div>{history.length === 0 ? <p className={styles.empty}>No local speaker communication batches have been queued for this event.</p> : <div className={styles.historyTableWrap}><table className={styles.historyTable}><caption>Persisted local speaker message history; provider delivery is not represented.</caption><thead><tr><th scope="col">Recipient</th><th scope="col">Message</th><th scope="col">State</th><th scope="col">Queued at</th></tr></thead><tbody>{history.map((entry) => <HistoryRow key={entry.messageId} entry={entry} />)}</tbody></table></div>}</section>;
}

function HistoryRow({ entry }: { readonly entry: SpeakerCommunicationDeliveryLogEntry }) {
  return <tr><td><strong>{entry.displayName}</strong><span className={styles.tableDetail}>{entry.normalizedEmail}</span></td><td><details><summary>{entry.subjectPreview}</summary><pre>{entry.bodyPreview}</pre><span className={styles.tableDetail}>Message {entry.messageId} · batch {entry.domainEventId}</span></details></td><td><span className={styles.status} data-state={entry.status}>{entry.status}</span><span className={styles.tableDetail}>Local only · not delivered</span></td><td><time dateTime={entry.createdAt}>{entry.createdAt}</time><span className={styles.tableDetail}>Attempts {entry.attemptCount}</span></td></tr>;
}
