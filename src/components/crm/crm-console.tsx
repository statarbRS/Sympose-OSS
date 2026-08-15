"use client";

import Link from "next/link";
import type { ChangeEvent, FormEvent } from "react";
import { useActionState, useEffect, useMemo, useState } from "react";

import {
  addCrmPersonToEventAction,
  confirmCrmCsvAction,
  previewCrmCsvAction,
  queueCrmBulkEmailAction,
  type CrmBulkEmailActionState,
  type CrmEventLinkActionState,
} from "@/app/w/[workspace]/crm/actions";

import type {
  CrmCsvImportReceipt,
  CrmCsvPreview,
  CrmDirectoryMetrics,
  CrmPersonSummary,
} from "@/server/services/crm";
import {
  CRM_CSV_HEADER,
  CRM_CSV_MAX_BYTES,
  CRM_CSV_MAX_ROWS,
} from "@/server/services/crm/contracts";
import type { SpeakerCommunicationDeliveryLogEntry } from "@/server/services/speaker-communications";

import styles from "./crm-console.module.css";
import { CRM_PEOPLE_PAGE_SIZE, paginateCrmPeople } from "./pagination";

export const CRM_STAGES = [
  { id: "new", label: "New", description: "No local follow-up marked" },
  { id: "engaged", label: "Engaged", description: "A local follow-up is underway" },
  { id: "qualified", label: "Qualified", description: "Organizer marked a local fit" },
  { id: "nurture", label: "Nurture", description: "Keep warm for a later moment" },
  { id: "inactive", label: "Inactive", description: "Pause local follow-up" },
] as const;

type CrmStage = (typeof CRM_STAGES)[number]["id"];
type StageFilter = CrmStage | "all";
type CrmView = "directory" | "pipeline";
type CrmSort = "name" | "organization" | "stage" | "recent";

interface StageHistoryEntry {
  from: CrmStage;
  to: CrmStage;
  changedAt: string;
}

interface LocalOverlay {
  stage: CrmStage;
  tags: string[];
  note: string;
  stageHistory: StageHistoryEntry[];
}

interface SavedSegment {
  id: string;
  name: string;
  search: string;
  stage: StageFilter;
  tag: string;
  sort?: CrmSort;
  createdAt: string;
}

interface StoredCrmState {
  version: 1;
  overlays: Record<string, LocalOverlay>;
  segments: SavedSegment[];
}

interface CrmFilters {
  search: string;
  stage: StageFilter;
  tag: string;
  sort: CrmSort;
}

const STORAGE_VERSION = 1 as const;
const MAX_NOTE_LENGTH = 600;
const MAX_TAG_LENGTH = 32;
const MAX_TAGS_PER_PERSON = 8;
const MAX_STAGE_HISTORY = 24;
const MAX_SEGMENTS = 12;
const DEFAULT_BULK_SUBJECT = "Update for {{eventName}}";
const DEFAULT_BULK_BODY = "Hi {{firstName}},\n\nWe have an update about {{eventName}}.\n\nBest,\nThe organizing team";
const BULK_PLACEHOLDERS = ["{{displayName}}", "{{firstName}}", "{{organization}}", "{{title}}", "{{eventName}}"] as const;
const BULK_TEMPLATE_PATTERN = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu;
const IDLE_EVENT_LINK_ACTION: CrmEventLinkActionState = { kind: "idle" };
const IDLE_BULK_EMAIL_ACTION: CrmBulkEmailActionState = { kind: "idle" };

export interface CrmEventMembershipEvidence {
  readonly personId: string;
  readonly roleKey: string;
  readonly participationStatus: string;
  readonly updatedAt: string;
}

export interface CrmEventSurface {
  readonly id: string;
  readonly name: string;
  readonly lifecycle: string;
  readonly memberships: readonly CrmEventMembershipEvidence[];
  readonly history: readonly SpeakerCommunicationDeliveryLogEntry[];
  readonly nextCommunicationIdempotencyKey: string;
  readonly linkIdempotencyKeys: Readonly<Record<string, string>>;
  readonly maxRecipients: number;
}

function isCrmStage(value: unknown): value is CrmStage {
  return CRM_STAGES.some((stage) => stage.id === value);
}

function stageLabel(stage: CrmStage): string {
  return CRM_STAGES.find((candidate) => candidate.id === stage)?.label ?? "New";
}

function stageDescription(stage: CrmStage): string {
  return CRM_STAGES.find((candidate) => candidate.id === stage)?.description ?? "Local CRM stage";
}

function starterStage(personId: string, index: number): CrmStage {
  const stableSum = [...personId].reduce((sum, character) => sum + character.charCodeAt(0), index);
  return CRM_STAGES[stableSum % CRM_STAGES.length].id;
}

function starterOverlay(personId: string, index: number): LocalOverlay {
  return {
    stage: starterStage(personId, index),
    tags: [],
    note: "",
    stageHistory: [],
  };
}

function normaliseTag(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const tag = value.trim().replace(/\s+/gu, " ").slice(0, MAX_TAG_LENGTH);
  return tag.length > 0 ? tag : null;
}

function normaliseOverlay(value: unknown, fallback: LocalOverlay): LocalOverlay {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const candidate = value as Partial<LocalOverlay>;
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags
        .map(normaliseTag)
        .filter((tag): tag is string => Boolean(tag))
        .filter((tag, index, all) => all.findIndex((other) => other.toLowerCase() === tag.toLowerCase()) === index)
        .slice(0, MAX_TAGS_PER_PERSON)
    : [];
  const stageHistory = Array.isArray(candidate.stageHistory)
    ? candidate.stageHistory
        .filter((entry): entry is StageHistoryEntry => {
          if (!entry || typeof entry !== "object") {
            return false;
          }
          const item = entry as Partial<StageHistoryEntry>;
          return isCrmStage(item.from) && isCrmStage(item.to) && typeof item.changedAt === "string";
        })
        .map((entry) => ({
          from: entry.from,
          to: entry.to,
          changedAt: entry.changedAt.slice(0, 64),
        }))
        .slice(-MAX_STAGE_HISTORY)
    : [];

  return {
    stage: isCrmStage(candidate.stage) ? candidate.stage : fallback.stage,
    tags,
    note: typeof candidate.note === "string" ? candidate.note.slice(0, MAX_NOTE_LENGTH) : "",
    stageHistory,
  };
}

function createStarterState(people: CrmPersonSummary[]): StoredCrmState {
  const overlays: Record<string, LocalOverlay> = {};
  people.forEach((person, index) => {
    overlays[person.id] = starterOverlay(person.id, index);
  });
  return { version: STORAGE_VERSION, overlays, segments: [] };
}

function normaliseSegment(value: unknown): SavedSegment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<SavedSegment>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") {
    return null;
  }
  const stage = candidate.stage === "all" || isCrmStage(candidate.stage) ? candidate.stage : "all";
  return {
    id: candidate.id.slice(0, 96),
    name: candidate.name.trim().slice(0, 48) || "Untitled segment",
    search: typeof candidate.search === "string" ? candidate.search.slice(0, 80) : "",
    stage,
    tag: typeof candidate.tag === "string" ? candidate.tag.slice(0, MAX_TAG_LENGTH) : "all",
    sort: candidate.sort === "organization" || candidate.sort === "stage" || candidate.sort === "recent" ? candidate.sort : "name",
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt.slice(0, 64) : "",
  };
}

function readStoredState(storageKey: string, people: CrmPersonSummary[]): StoredCrmState {
  const starter = createStarterState(people);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return starter;
    }
    const parsed = JSON.parse(raw) as Partial<StoredCrmState>;
    if (parsed.version !== STORAGE_VERSION || !parsed.overlays || typeof parsed.overlays !== "object") {
      return starter;
    }

    const overlays: Record<string, LocalOverlay> = {};
    people.forEach((person, index) => {
      overlays[person.id] = normaliseOverlay(
        (parsed.overlays as Record<string, unknown>)[person.id],
        starterOverlay(person.id, index),
      );
    });
    const segments = Array.isArray(parsed.segments)
      ? parsed.segments
          .map(normaliseSegment)
          .filter((segment): segment is SavedSegment => Boolean(segment))
          .slice(0, MAX_SEGMENTS)
      : [];
    return { version: STORAGE_VERSION, overlays, segments };
  } catch {
    return starter;
  }
}

function persistState(storageKey: string, state: StoredCrmState): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Browser storage can be disabled or full; the in-memory surface remains usable.
  }
}

function formatLocalDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function initials(name: string): string {
  const parts = name.split(/\s+/u).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "P";
}

function segmentId(): string {
  return `segment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function previewStatusLabel(row: CrmCsvPreview["rows"][number]): string {
  if (row.disposition === "CREATE") {
    return "Create canonical Person";
  }
  if (row.disposition === "MERGE_CANDIDATE") {
    return row.matchReason === "EMAIL_EXACT"
      ? "Merge candidate · exact email"
      : "Merge candidate · normalized name";
  }
  return `Rejected · ${row.reason ?? "invalid row"}`;
}

function receiptStatusLabel(row: CrmCsvImportReceipt["rows"][number]): string {
  if (row.status === "CREATED") {
    return "Created canonical Person";
  }
  if (row.status === "MERGED") {
    return "Merged source evidence";
  }
  return `Rejected · ${row.reason ?? "invalid row"}`;
}

function renderBulkTemplate(template: string, person: CrmPersonSummary, eventName: string): string {
  const values: Record<string, string> = {
    displayName: person.fullName,
    firstName: person.fullName.trim().split(/\s+/u, 1)[0] ?? person.fullName,
    organization: person.organization ?? "",
    title: person.title ?? "",
    eventName,
  };
  return template.replace(BULK_TEMPLATE_PATTERN, (_whole, name: string) => values[name] ?? "");
}

function CrmEventOperations({
  workspaceSlug,
  event,
  people,
}: {
  readonly workspaceSlug: string;
  readonly event: CrmEventSurface;
  readonly people: readonly CrmPersonSummary[];
}) {
  const linkedPersonIds = useMemo(
    () => new Set(event.memberships.map((membership) => membership.personId)),
    [event.memberships],
  );
  const eventPeople = useMemo(
    () => people.filter((person) => linkedPersonIds.has(person.id)),
    [linkedPersonIds, people],
  );
  const [linkPersonId, setLinkPersonId] = useState(
    () => people.find((person) => !linkedPersonIds.has(person.id))?.id ?? people[0]?.id ?? "",
  );
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<ReadonlySet<string>>(() => new Set());
  const [subjectTemplate, setSubjectTemplate] = useState(DEFAULT_BULK_SUBJECT);
  const [bodyTemplate, setBodyTemplate] = useState(DEFAULT_BULK_BODY);
  const [linkState, linkAction, linkPending] = useActionState<CrmEventLinkActionState, FormData>(
    addCrmPersonToEventAction,
    IDLE_EVENT_LINK_ACTION,
  );
  const [bulkState, bulkAction, bulkPending] = useActionState<CrmBulkEmailActionState, FormData>(
    queueCrmBulkEmailAction,
    IDLE_BULK_EMAIL_ACTION,
  );
  const selectedRecipients = useMemo(
    () => eventPeople.filter((person) => selectedRecipientIds.has(person.id)),
    [eventPeople, selectedRecipientIds],
  );
  const previewRecipient = selectedRecipients[0] ?? null;
  const linkIdempotencyKey = event.linkIdempotencyKeys[linkPersonId] ?? "";

  function toggleRecipient(personId: string): void {
    setSelectedRecipientIds((current) => {
      const next = new Set(current);
      if (next.has(personId)) {
        next.delete(personId);
      } else if (next.size < event.maxRecipients) {
        next.add(personId);
      }
      return next;
    });
  }

  return (
    <div className={styles.eventOperations} data-testid="crm-event-operations">
      <section className={styles.eventActionCard} aria-labelledby={`crm-event-link-${event.id}`}>
        <div className={styles.eventActionHeading}>
          <div>
            <p className={styles.panelKicker}>CRM-10 · canonical identity</p>
            <h3 id={`crm-event-link-${event.id}`}>Add a Person as a pending speaker</h3>
          </div>
          <span className={styles.persistentBadge}>Persistent event evidence</span>
        </div>
        <p className={styles.eventActionCopy}>
          This reuses the selected canonical Person and creates only the existing event speaker relationship.
          It does not create a contact copy or imply an invitation, registration, commitment, or attendance.
        </p>
        <form action={linkAction} className={styles.eventLinkForm} data-testid="crm-event-link-form">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="eventId" value={event.id} />
          <input type="hidden" name="idempotencyKey" value={linkIdempotencyKey} />
          <label className={styles.field}>
            <span>Canonical Person</span>
            <select
              name="personId"
              value={linkPersonId}
              disabled={people.length === 0}
              onChange={(changeEvent) => setLinkPersonId(changeEvent.currentTarget.value)}
            >
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName} · {person.canonicalEmail}{linkedPersonIds.has(person.id) ? " · already a speaker" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={linkPending || !linkPersonId || !linkIdempotencyKey}
          >
            {linkPending ? "Saving relationship…" : "Add as pending speaker"}
          </button>
        </form>
        {linkState.kind === "error" ? (
          <p className={styles.eventActionError} role="alert" data-testid="crm-event-link-error">
            <strong>Relationship not saved.</strong> {linkState.message}
          </p>
        ) : null}
        {linkState.kind === "success" ? (
          <div className={styles.eventActionSuccess} role="status" aria-live="polite" data-testid="crm-event-link-success">
            <strong>{linkState.message}</strong>
            <span>
              Person {linkState.person.id} · event {linkState.event.id} · role {linkState.roleKey} · state {linkState.participationStatus} · {linkState.revalidated ? "reload projection refreshed" : "refresh to verify the reload projection"}.
            </span>
          </div>
        ) : null}
        <div className={styles.membershipSummary} data-testid="crm-event-membership-evidence">
          <strong>{event.memberships.length} persistent pending speaker relationship{event.memberships.length === 1 ? "" : "s"}</strong>
          {eventPeople.length === 0 ? (
            <span>No CRM contact is eligible for this event&apos;s local email queue yet.</span>
          ) : (
            <ul>
              {event.memberships.map((membership) => {
                const person = people.find((candidate) => candidate.id === membership.personId);
                return (
                  <li key={`${membership.personId}-${membership.roleKey}`}>
                    <span>{person?.fullName ?? membership.personId}</span>
                    <strong>{membership.roleKey} · {membership.participationStatus}</strong>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className={styles.eventActionCard} aria-labelledby={`crm-bulk-email-${event.id}`}>
        <div className={styles.eventActionHeading}>
          <div>
            <p className={styles.panelKicker}>CRM-11 · durable local outbox</p>
            <h3 id={`crm-bulk-email-${event.id}`}>Queue a bounded bulk email</h3>
          </div>
          <span className={styles.queuedBadge}>Queued, never “sent”</span>
        </div>
        <div className={styles.providerBoundary} role="note" data-testid="crm-email-provider-boundary">
          <strong>No email provider is connected.</strong>
          <span>The action writes local PENDING outbox evidence only. It makes no network call and claims no delivery.</span>
        </div>
        <form action={bulkAction} className={styles.bulkEmailForm} data-testid="crm-bulk-email-form">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="eventId" value={event.id} />
          <input type="hidden" name="idempotencyKey" value={event.nextCommunicationIdempotencyKey} />
          <div className={styles.bulkEditorGrid}>
            <fieldset className={styles.recipientFieldset}>
              <legend>Event-linked contacts</legend>
              <div className={styles.recipientToolbar}>
                <span>{selectedRecipients.length} selected · maximum {event.maxRecipients}</span>
                <div>
                  <button
                    type="button"
                    className={styles.textButton}
                    disabled={eventPeople.length === 0}
                    onClick={() => setSelectedRecipientIds(new Set(eventPeople.slice(0, event.maxRecipients).map((person) => person.id)))}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className={styles.textButton}
                    disabled={selectedRecipients.length === 0}
                    onClick={() => setSelectedRecipientIds(new Set())}
                  >
                    Clear
                  </button>
                </div>
              </div>
              {eventPeople.length === 0 ? (
                <p className={styles.eventEmpty}>Add a canonical Person as a pending speaker before queueing a message.</p>
              ) : (
                <ul className={styles.crmRecipientList}>
                  {eventPeople.map((person) => {
                    const checked = selectedRecipientIds.has(person.id);
                    const atLimit = !checked && selectedRecipientIds.size >= event.maxRecipients;
                    return (
                      <li key={person.id}>
                        <label>
                          <input
                            type="checkbox"
                            name="personId"
                            value={person.id}
                            checked={checked}
                            disabled={atLimit}
                            onChange={() => toggleRecipient(person.id)}
                          />
                          <span>
                            <strong>{person.fullName}</strong>
                            <small>{person.canonicalEmail}</small>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </fieldset>
            <div className={styles.messageFields}>
              <label className={styles.field}>
                <span>Subject · plain text</span>
                <input
                  name="subjectTemplate"
                  value={subjectTemplate}
                  maxLength={240}
                  required
                  onChange={(changeEvent) => setSubjectTemplate(changeEvent.currentTarget.value)}
                />
              </label>
              <label className={styles.field}>
                <span>Body · plain text</span>
                <textarea
                  name="bodyTemplate"
                  value={bodyTemplate}
                  maxLength={12_000}
                  rows={8}
                  required
                  onChange={(changeEvent) => setBodyTemplate(changeEvent.currentTarget.value)}
                />
              </label>
              <p className={styles.mergeFieldHelp}>
                Merge fields: {BULK_PLACEHOLDERS.map((placeholder) => <code key={placeholder}>{placeholder}</code>)}
              </p>
              <div className={styles.renderedPreview} aria-label="Rendered CRM email preview" data-testid="crm-email-rendered-preview">
                <div>
                  <strong>Rendered preview</strong>
                  <span>{previewRecipient ? `${previewRecipient.fullName} · ${previewRecipient.canonicalEmail}` : "Select a recipient"}</span>
                </div>
                {previewRecipient ? (
                  <>
                    <p>{renderBulkTemplate(subjectTemplate, previewRecipient, event.name)}</p>
                    <pre>{renderBulkTemplate(bodyTemplate, previewRecipient, event.name)}</pre>
                  </>
                ) : (
                  <span>Select an event-linked contact to preview the rendered recipient, subject, and body.</span>
                )}
              </div>
            </div>
          </div>
          {bulkState.kind === "error" ? (
            <p className={styles.eventActionError} role="alert" data-testid="crm-bulk-email-error">
              <strong>Nothing queued.</strong> {bulkState.message}
            </p>
          ) : null}
          {bulkState.kind === "success" ? (
            <div className={styles.queueReceipt} role="status" aria-live="polite" data-testid="crm-bulk-email-success">
              <strong>{bulkState.message}</strong>
              <span>Batch {bulkState.batchId} · local channel · provider mutation false · {bulkState.revalidated ? "reload projection refreshed" : "refresh to verify the reload projection"}.</span>
              <ul>
                {bulkState.messages.map((message) => (
                  <li key={message.messageId}>
                    <strong>{message.displayName} &lt;{message.normalizedEmail}&gt;</strong>
                    <span>Subject: {message.subject}</span>
                    <pre>{message.body}</pre>
                    <small>{message.status} · queued locally, not sent · {message.messageId}</small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className={styles.queueSubmitRow}>
            <span>{selectedRecipients.length === 0 ? "Select at least one event-linked contact." : "Queueing persists rendered messages; it does not send them."}</span>
            <button
              type="submit"
              className={styles.primaryButton}
              disabled={bulkPending || selectedRecipients.length === 0}
            >
              {bulkPending ? "Queueing…" : `Queue ${selectedRecipients.length} local message${selectedRecipients.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </form>
        <section className={styles.crmQueueHistory} aria-labelledby={`crm-queue-history-${event.id}`} data-testid="crm-email-queue-history">
          <div className={styles.eventActionHeading}>
            <div>
              <p className={styles.panelKicker}>Reload-safe evidence</p>
              <h4 id={`crm-queue-history-${event.id}`}>Persisted queue history</h4>
            </div>
            <span>{event.history.length} message row{event.history.length === 1 ? "" : "s"}</span>
          </div>
          {event.history.length === 0 ? (
            <p className={styles.eventEmpty}>No durable local CRM messages have been queued for this event.</p>
          ) : (
            <div className={styles.queueTableWrap} tabIndex={0}>
              <table className={styles.queueTable}>
                <caption>Persisted rendered local outbox evidence; provider delivery is not represented.</caption>
                <thead>
                  <tr><th scope="col">Recipient</th><th scope="col">Rendered message</th><th scope="col">Truthful state</th><th scope="col">Queued at</th></tr>
                </thead>
                <tbody>
                  {event.history.map((entry) => (
                    <tr key={entry.messageId}>
                      <td><strong>{entry.displayName}</strong><span>{entry.normalizedEmail}</span></td>
                      <td><details><summary>{entry.subjectPreview}</summary><pre>{entry.bodyPreview}</pre><small>Message {entry.messageId} · batch {entry.domainEventId}</small></details></td>
                      <td>
                        <strong>{entry.status === "PENDING" ? "QUEUED · PENDING" : `LOCAL OUTBOX · ${entry.status}`}</strong>
                        <span>{entry.status === "PENDING" ? "Not sent" : "Local simulation status"} · provider mutation false</span>
                      </td>
                      <td><time dateTime={entry.createdAt}>{formatLocalDate(entry.createdAt)}</time><span>{entry.attemptCount} attempts</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}

export function CrmConsole({
  workspaceSlug,
  workspaceName,
  people,
  metrics,
  events,
}: {
  workspaceSlug: string;
  workspaceName: string;
  people: CrmPersonSummary[];
  metrics: CrmDirectoryMetrics;
  events: readonly CrmEventSurface[];
}) {
  const storageKey = `sympose.crm.overlay.v1.${encodeURIComponent(workspaceSlug)}`;
  const [localState, setLocalState] = useState<StoredCrmState>(() => createStarterState(people));
  const [storageReady, setStorageReady] = useState(false);
  const [filters, setFilters] = useState<CrmFilters>({ search: "", stage: "all", tag: "all", sort: "name" });
  const [view, setView] = useState<CrmView>("directory");
  const [peoplePageNumber, setPeoplePageNumber] = useState(1);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [segmentName, setSegmentName] = useState("");
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [csvDraft, setCsvDraft] = useState("");
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState(events[0]?.id ?? "");
  const [previewState, previewAction, previewPending] = useActionState(previewCrmCsvAction, null);
  const [confirmState, confirmAction, confirmPending] = useActionState(confirmCrmCsvAction, null);
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0] ?? null;
  const personIndexById = useMemo(
    () => new Map(people.map((person, index) => [person.id, index])),
    [people],
  );

  useEffect(() => {
    setLocalState(readStoredState(storageKey, people));
    setStorageReady(true);
  }, [people, storageKey]);

  useEffect(() => {
    if (storageReady) {
      persistState(storageKey, localState);
    }
  }, [localState, storageKey, storageReady]);

  const allTags = useMemo(
    () =>
      [...new Set(Object.values(localState.overlays).flatMap((overlay) => overlay.tags))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [localState.overlays],
  );

  const overlayFor = (person: CrmPersonSummary, index: number): LocalOverlay =>
    localState.overlays[person.id] ?? starterOverlay(person.id, index);

  const filteredPeople = useMemo(() => {
    const query = filters.search.trim().toLocaleLowerCase();
    const matches = people.filter((person, index) => {
      const overlay = localState.overlays[person.id] ?? starterOverlay(person.id, index);
      const searchable = [
        person.fullName,
        person.canonicalEmail,
        person.organization ?? "",
        person.title ?? "",
        ...overlay.tags,
      ]
        .join(" ")
        .toLocaleLowerCase();
      const matchesSearch = query.length === 0 || searchable.includes(query);
      const matchesStage = filters.stage === "all" || overlay.stage === filters.stage;
      const matchesTag = filters.tag === "all" || overlay.tags.includes(filters.tag);
      return matchesSearch && matchesStage && matchesTag;
    });
    const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    return [...matches].sort((left, right) => {
      const leftOverlay = overlayFor(left, personIndexById.get(left.id) ?? 0);
      const rightOverlay = overlayFor(right, personIndexById.get(right.id) ?? 0);
      if (filters.sort === "organization") {
        return collator.compare(left.organization ?? "", right.organization ?? "") || collator.compare(left.fullName, right.fullName);
      }
      if (filters.sort === "stage") {
        return collator.compare(stageLabel(leftOverlay.stage), stageLabel(rightOverlay.stage)) || collator.compare(left.fullName, right.fullName);
      }
      if (filters.sort === "recent") {
        const leftDate = leftOverlay.stageHistory.at(-1)?.changedAt ?? "";
        const rightDate = rightOverlay.stageHistory.at(-1)?.changedAt ?? "";
        return collator.compare(rightDate, leftDate) || collator.compare(left.fullName, right.fullName);
      }
      return collator.compare(left.fullName, right.fullName);
    });
  }, [filters, localState.overlays, people, personIndexById]);

  const localMetrics = useMemo(() => {
    const overlays = people.map((person, index) => overlayFor(person, index));
    return {
      withNotes: overlays.filter((overlay) => overlay.note.trim().length > 0).length,
      tagged: overlays.filter((overlay) => overlay.tags.length > 0).length,
      activeFollowUps: overlays.filter((overlay) => overlay.stage === "engaged" || overlay.stage === "qualified").length,
      changedStages: overlays.filter((overlay) => overlay.stageHistory.length > 0).length,
    };
  }, [localState.overlays, people]);

  const peoplePage = useMemo(
    () => paginateCrmPeople(filteredPeople, peoplePageNumber),
    [filteredPeople, peoplePageNumber],
  );

  function updateFilters(update: Partial<CrmFilters>): void {
    setFilters((current) => ({ ...current, ...update }));
    setPeoplePageNumber(1);
    setActiveSegmentId(null);
  }

  function updateOverlay(personId: string, update: (current: LocalOverlay) => LocalOverlay): void {
    setLocalState((currentState) => {
      const personIndex = personIndexById.get(personId) ?? -1;
      const current = currentState.overlays[personId] ?? starterOverlay(personId, Math.max(personIndex, 0));
      const next = normaliseOverlay(update(current), current);
      return {
        ...currentState,
        overlays: { ...currentState.overlays, [personId]: next },
      };
    });
  }

  function changeStage(personId: string, nextStage: CrmStage): void {
    updateOverlay(personId, (current) => {
      if (current.stage === nextStage) {
        return current;
      }
      return {
        ...current,
        stage: nextStage,
        stageHistory: [
          ...current.stageHistory,
          { from: current.stage, to: nextStage, changedAt: new Date().toISOString() },
        ].slice(-MAX_STAGE_HISTORY),
      };
    });
    setNotice("Stage change saved to this browser only; it is not a commitment or provider update.");
  }

  function addTag(event: FormEvent<HTMLFormElement>, personId: string): void {
    event.preventDefault();
    const candidate = normaliseTag(tagDrafts[personId]);
    if (!candidate) {
      return;
    }
    updateOverlay(personId, (current) => {
      if (
        current.tags.length >= MAX_TAGS_PER_PERSON ||
        current.tags.some((tag) => tag.toLowerCase() === candidate.toLowerCase())
      ) {
        return current;
      }
      return { ...current, tags: [...current.tags, candidate] };
    });
    setTagDrafts((current) => ({ ...current, [personId]: "" }));
    setNotice("Tag saved to this browser only.");
  }

  function removeTag(personId: string, tagToRemove: string): void {
    updateOverlay(personId, (current) => ({
      ...current,
      tags: current.tags.filter((tag) => tag !== tagToRemove),
    }));
    setNotice("Tag removed from this browser only.");
  }

  function saveSegment(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const name = segmentName.trim().slice(0, 48);
    if (!name) {
      setNotice("Give the local segment a name before saving it.");
      return;
    }
    const segment: SavedSegment = {
      id: segmentId(),
      name,
      search: filters.search,
      stage: filters.stage,
      tag: filters.tag,
      sort: filters.sort,
      createdAt: new Date().toISOString(),
    };
    setLocalState((current) => ({
      ...current,
      segments: [segment, ...current.segments].slice(0, MAX_SEGMENTS),
    }));
    setActiveSegmentId(segment.id);
    setSegmentName("");
    setNotice("Segment saved to this browser only.");
  }

  function applySegment(segment: SavedSegment): void {
    setFilters({ search: segment.search, stage: segment.stage, tag: segment.tag, sort: segment.sort ?? "name" });
    setPeoplePageNumber(1);
    setActiveSegmentId(segment.id);
    setNotice(`Showing the local segment “${segment.name}”.`);
  }

  function removeSegment(segmentIdToRemove: string): void {
    setLocalState((current) => ({
      ...current,
      segments: current.segments.filter((segment) => segment.id !== segmentIdToRemove),
    }));
    setActiveSegmentId((current) => (current === segmentIdToRemove ? null : current));
    setNotice("Segment removed from this browser only.");
  }

  async function readCsvFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }
    if (file.size > CRM_CSV_MAX_BYTES) {
      setNotice(`Choose a CSV no larger than ${Math.round(CRM_CSV_MAX_BYTES / 1024)} KiB.`);
      return;
    }
    setCsvFileName(file.name.slice(0, 120));
    setCsvDraft(await file.text());
    setNotice("CSV loaded locally. Preview it before any canonical write or merge.");
  }

  const renderStageSelect = (person: CrmPersonSummary, overlay: LocalOverlay, compact = false) => (
    <label className={compact ? styles.compactField : styles.field}>
      <span>{compact ? "Stage" : "Local pipeline stage"}</span>
      <select
        value={overlay.stage}
        aria-label={`Local pipeline stage for ${person.fullName}`}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (isCrmStage(value)) {
            changeStage(person.id, value);
          }
        }}
      >
        {CRM_STAGES.map((stage) => (
          <option key={stage.id} value={stage.id}>
            {stage.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className={styles.page}>
      <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
        <Link href={`/w/${workspaceSlug}/dashboard`}>Dashboard</Link>
        <span aria-hidden="true">/</span>
        <span>CRM</span>
      </nav>

      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Optional organizer bonus · CRM</p>
          <h1>Relationship workspace</h1>
          <p className={styles.lede}>
            Search the canonical People graph for {workspaceName}, then layer on a small working view
            for local follow-up. CRM overlays never replace the person record.
          </p>
        </div>
        <div className={styles.heroAside}>
          <span className={styles.localBadge}>Canonical People · persistent event actions</span>
          <span className={styles.heroAsideText}>Local CRM overlays remain browser-scoped</span>
        </div>
      </header>

      <section className={styles.boundaryNotice} aria-label="CRM boundary notice">
        <div>
          <strong>Canonical People + persistent event evidence + browser-local CRM overlay</strong>
          <p>
            Names, titles, organizations, email addresses, and source counts come from the authorized
            workspace. Notes, tags, saved segments, and stage history stay in this browser only. Confirmed
            synthetic CSV rows append immutable source evidence and links. Event speaker relationships and
            local outbox rows persist across reloads; none of these actions deletes or overwrites a Person.
          </p>
        </div>
        <div className={styles.simulatedNote}>
          <span className={styles.simulatedDot} aria-hidden="true" />
          Local outbox only — queued does not mean sent, delivered, or committed.
        </div>
      </section>

      <section className={styles.eventPanel} aria-labelledby="crm-event-actions-title" data-testid="crm-event-actions">
        <div className={styles.eventPanelHeader}>
          <div>
            <p className={styles.panelKicker}>Event-scoped CRM actions</p>
            <h2 id="crm-event-actions-title">Event membership and local email queue</h2>
            <p>
              Select one authorized event. Membership and queue history below are persistent server evidence,
              separate from the browser-local pipeline, tags, notes, and segments.
            </p>
          </div>
          <label className={styles.eventSelect}>
            <span>Selected event</span>
            <select
              value={selectedEvent?.id ?? ""}
              disabled={events.length === 0}
              onChange={(changeEvent) => setSelectedEventId(changeEvent.currentTarget.value)}
            >
              {events.length === 0 ? <option value="">No authorized events</option> : null}
              {events.map((event) => (
                <option key={event.id} value={event.id}>{event.name} · {event.lifecycle}</option>
              ))}
            </select>
          </label>
        </div>
        {selectedEvent ? (
          <CrmEventOperations
            key={selectedEvent.id}
            workspaceSlug={workspaceSlug}
            event={selectedEvent}
            people={people}
          />
        ) : (
          <div className={styles.eventEmpty}>
            <strong>No event is available in this workspace.</strong>
            <span>CRM contacts cannot be linked or queued without an authorized selected event.</span>
          </div>
        )}
      </section>

      <section className={styles.importPanel} aria-labelledby="crm-import-title">
        <div className={styles.importHeader}>
          <div>
            <p className={styles.panelKicker}>Optional synthetic data lane</p>
            <h2 id="crm-import-title">Import contacts from CSV</h2>
            <p className={styles.importIntro}>
              Upload or paste a bounded CSV, preview normalized duplicate candidates, then explicitly confirm
              before any canonical Person or provenance records are appended.
            </p>
          </div>
          <span className={styles.sourceBadge}>Preview before merge</span>
        </div>

        <div className={styles.schemaNote} data-testid="crm-csv-schema">
          <strong>Documented schema</strong>
          <code>{CRM_CSV_HEADER.join(",")}</code>
          <span>
            Up to {CRM_CSV_MAX_ROWS} rows / {Math.round(CRM_CSV_MAX_BYTES / 1024)} KiB. Use reserved synthetic
            addresses such as <code>person@example.test</code>; no email is sent.
          </span>
        </div>

        <form action={previewAction} className={styles.importForm} data-testid="crm-csv-preview-form">
          <label className={styles.fileField}>
            <span>CSV file</span>
            <input
              type="file"
              accept=".csv,text/csv"
              data-testid="crm-csv-file"
              onChange={(event) => void readCsvFile(event)}
            />
            <small>{csvFileName ?? "No file loaded; paste the documented schema below."}</small>
          </label>
          <label className={styles.csvField}>
            <span>CSV contents</span>
            <textarea
              name="csv"
              value={csvDraft}
              required
              rows={6}
              data-testid="crm-csv-input"
              placeholder={`${CRM_CSV_HEADER.join(",")}\nalex@example.test,Alex Example,Example Org,Organizer`}
              onChange={(event) => {
                setCsvDraft(event.currentTarget.value);
                setCsvFileName(null);
              }}
            />
          </label>
          <button type="submit" className={styles.primaryButton} disabled={!csvDraft || previewPending}>
            {previewPending ? "Building preview…" : "Preview CSV"}
          </button>
        </form>

        {previewState ? (
          <p className={previewState.ok ? styles.importSuccess : styles.importError} role={previewState.ok ? "status" : "alert"}>
            {previewState.message}
          </p>
        ) : null}

        {previewState?.preview ? (
          <div className={styles.previewBlock} data-testid="crm-csv-preview">
            <div className={styles.previewSummary}>
              <span><strong>{previewState.preview.createCount}</strong> create</span>
              <span><strong>{previewState.preview.mergeCandidateCount}</strong> merge candidates</span>
              <span><strong>{previewState.preview.rejectedCount}</strong> rejected</span>
              <code>{previewState.preview.inputFingerprint.slice(0, 16)}…</code>
            </div>
            <div className={styles.importTableWrap}>
              <table className={styles.importTable}>
                <caption>Normalized CRM CSV preview; no canonical changes have occurred</caption>
                <thead>
                  <tr><th scope="col">Row</th><th scope="col">Contact</th><th scope="col">Decision</th><th scope="col">Match / reason</th></tr>
                </thead>
                <tbody>
                  {previewState.preview.rows.map((row) => (
                    <tr key={row.rowNumber}>
                      <th scope="row">{row.rowNumber}</th>
                      <td>{row.fullName || "Unnamed"}<br /><span>{row.email || "No email"}</span></td>
                      <td>{previewStatusLabel(row)}</td>
                      <td>{row.matchPersonName ? `Existing Person: ${row.matchPersonName}` : row.reason ?? "New canonical identity"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {previewState.preview.requiresConfirmation ? (
              <form action={confirmAction} className={styles.confirmForm} data-testid="crm-csv-confirm-form">
                <input type="hidden" name="csv" value={csvDraft} readOnly />
                <input type="hidden" name="inputFingerprint" value={previewState.preview.inputFingerprint} readOnly />
                <input type="hidden" name="confirm" value="yes" readOnly />
                <p>
                  Confirmation appends immutable synthetic source history and links normalized duplicate candidates
                  to the displayed Person. It never deletes or overwrites an existing Person.
                </p>
                <button type="submit" className={styles.confirmButton} disabled={confirmPending}>
                  {confirmPending ? "Committing…" : "Confirm import and merge candidates"}
                </button>
              </form>
            ) : null}
          </div>
        ) : null}

        {confirmState ? (
          <div className={confirmState.ok ? styles.receiptSuccess : styles.importError} role={confirmState.ok ? "status" : "alert"} data-testid="crm-csv-receipt">
            <strong>{confirmState.ok ? "Deterministic import receipt" : "Import not committed"}</strong>
            <p>{confirmState.message}</p>
            {confirmState.receipt ? (
              <>
                <code>{confirmState.receipt.receiptId}</code>
                <div className={styles.receiptCounts}>
                  <span>{confirmState.receipt.createdCount} created</span>
                  <span>{confirmState.receipt.mergedCount} merged</span>
                  <span>{confirmState.receipt.rejectedCount} rejected</span>
                </div>
                <ul>
                  {confirmState.receipt.rows.map((row) => (
                    <li key={row.rowNumber}>Row {row.rowNumber}: {receiptStatusLabel(row)}{row.personId ? ` · ${row.personId}` : ""}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className={styles.metrics} aria-label="CRM metrics">
        <div className={styles.metricCard}>
          <span>Canonical people</span>
          <strong>{metrics.totalPeople}</strong>
          <small>{metrics.sourcedPeople} with source evidence</small>
        </div>
        <div className={styles.metricCard}>
          <span>Organizations</span>
          <strong>{metrics.organizations}</strong>
          <small>{metrics.withOrganization} people have an organization</small>
        </div>
        <div className={styles.metricCard}>
          <span>Local follow-ups</span>
          <strong>{localMetrics.activeFollowUps}</strong>
          <small>Engaged or qualified locally</small>
        </div>
        <div className={styles.metricCard}>
          <span>Local notes</span>
          <strong>{localMetrics.withNotes}</strong>
          <small>{localMetrics.tagged} tagged · {localMetrics.changedStages} stage histories</small>
        </div>
      </section>

      <section className={styles.workspacePanel} aria-labelledby="directory-title">
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>Object collection · canonical People</p>
            <h2 id="directory-title">People workspace</h2>
          </div>
          <div className={styles.viewToggle} role="tablist" aria-label="CRM view">
            <button
              type="button"
              role="tab"
              aria-selected={view === "directory"}
              className={view === "directory" ? styles.viewButtonActive : styles.viewButton}
              onClick={() => {
                setView("directory");
                setPeoplePageNumber(1);
              }}
            >
              Directory
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "pipeline"}
              className={view === "pipeline" ? styles.viewButtonActive : styles.viewButton}
              onClick={() => {
                setView("pipeline");
                setPeoplePageNumber(1);
              }}
            >
              Pipeline
            </button>
          </div>
        </div>

        <div className={styles.filters}>
          <label className={styles.searchField}>
            <span>Search People</span>
            <input
              type="search"
              value={filters.search}
              placeholder="Name, email, title, organization, or tag"
              onChange={(event) => updateFilters({ search: event.currentTarget.value.slice(0, 80) })}
            />
          </label>
          <label className={styles.field}>
            <span>Stage</span>
            <select
              value={filters.stage}
              onChange={(event) => {
                const value = event.currentTarget.value;
                updateFilters({ stage: value === "all" || isCrmStage(value) ? value : "all" });
              }}
            >
              <option value="all">All stages</option>
              {CRM_STAGES.map((stage) => (
                <option key={stage.id} value={stage.id}>{stage.label}</option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Tag</span>
            <select
              value={filters.tag}
              onChange={(event) => updateFilters({ tag: event.currentTarget.value })}
            >
              <option value="all">All tags</option>
              {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>Sort</span>
            <select
              value={filters.sort}
              aria-label="Sort People"
              onChange={(event) => {
                const value = event.currentTarget.value;
                updateFilters({ sort: value === "organization" || value === "stage" || value === "recent" ? value : "name" });
              }}
            >
              <option value="name">Name A–Z</option>
              <option value="organization">Organization A–Z</option>
              <option value="stage">Local stage</option>
              <option value="recent">Recent local activity</option>
            </select>
          </label>
          <button
            type="button"
            className={styles.clearButton}
            onClick={() => {
              setFilters({ search: "", stage: "all", tag: "all", sort: "name" });
              setPeoplePageNumber(1);
              setActiveSegmentId(null);
            }}
          >
            Clear filters
          </button>
        </div>

        <div className={styles.segmentBar}>
          <div className={styles.segmentHeading}>
            <span className={styles.segmentLabel}>Saved local segments</span>
            <span className={styles.segmentHint}>Workspace-scoped browser views</span>
          </div>
          <form className={styles.segmentForm} onSubmit={saveSegment}>
            <label className={styles.visuallyHidden} htmlFor="crm-segment-name">Segment name</label>
            <input
              id="crm-segment-name"
              type="text"
              value={segmentName}
              maxLength={48}
              placeholder="Name this view"
              onChange={(event) => setSegmentName(event.currentTarget.value)}
            />
            <button type="submit" className={styles.secondaryButton}>Save segment</button>
          </form>
          {localState.segments.length > 0 ? (
            <div className={styles.segmentList} aria-label="Saved segments">
              {localState.segments.map((segment) => (
                <span key={segment.id} className={activeSegmentId === segment.id ? styles.segmentActive : styles.segment}>
                  <button type="button" onClick={() => applySegment(segment)}>{segment.name}</button>
                  <button
                    type="button"
                    className={styles.segmentRemove}
                    aria-label={`Remove ${segment.name} segment`}
                    onClick={() => removeSegment(segment.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className={styles.resultBar} role="status" aria-live="polite">
          <span>
            Showing <strong>{filteredPeople.length}</strong> of {people.length} canonical people
          </span>
          <span className={styles.resultDetail}>
            {view === "directory" ? "Directory view" : "Stage board"} · Rows {peoplePage.firstItemNumber}–{peoplePage.lastItemNumber} · Local overlays are not synced
          </span>
        </div>

        {filteredPeople.length > CRM_PEOPLE_PAGE_SIZE ? (
          <nav className={styles.pagination} aria-label="People workspace pages">
            <button
              type="button"
              disabled={peoplePage.pageNumber === 1}
              onClick={() => setPeoplePageNumber(peoplePage.pageNumber - 1)}
            >
              Previous
            </button>
            <span aria-live="polite">
              Page <strong>{peoplePage.pageNumber}</strong> of {peoplePage.pageCount} · {peoplePage.firstItemNumber}–{peoplePage.lastItemNumber} of {peoplePage.totalItems}
            </span>
            <button
              type="button"
              disabled={peoplePage.pageNumber === peoplePage.pageCount}
              onClick={() => setPeoplePageNumber(peoplePage.pageNumber + 1)}
            >
              Next
            </button>
          </nav>
        ) : null}

        {notice ? (
          <p className={styles.inlineNotice} role="status">
            {notice}
          </p>
        ) : null}

        {view === "directory" ? (
          <div className={styles.directory} role="region" aria-label="Canonical People directory">
            {filteredPeople.length > 0 ? (
              <div className={styles.directoryTableWrap} tabIndex={0}>
                <table className={styles.directoryTable}>
                  <caption>Canonical people with browser-local CRM context</caption>
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Organization</th>
                      <th scope="col">Canonical email</th>
                      <th scope="col">Local stage</th>
                      <th scope="col">Tags</th>
                      <th scope="col">Note</th>
                      <th scope="col">History</th>
                    </tr>
                  </thead>
                  <tbody>
                    {peoplePage.items.map((person) => {
                      const index = personIndexById.get(person.id) ?? 0;
                      const overlay = overlayFor(person, index);
                      const eventMembership = selectedEvent?.memberships.find((membership) => membership.personId === person.id);
                      return (
                        <tr key={person.id}>
                          <th scope="row" data-label="Person">
                            <div className={styles.tablePerson}>
                              <span className={styles.avatar} aria-hidden="true">{initials(person.fullName)}</span>
                              <div className={styles.contactIdentity}>
                                <Link className={styles.contactName} href={`/w/${workspaceSlug}/people/${person.id}`}>
                                  {person.fullName}
                                </Link>
                                <span className={styles.personRole}>{[person.title, person.organization].filter(Boolean).join(" · ") || "No title or organization"}</span>
                                <span className={styles.personMeta}>Canonical Person · {person.sourceCount} source{person.sourceCount === 1 ? "" : "s"}</span>
                                <span className={eventMembership ? styles.eventMember : styles.eventNotMember}>
                                  {selectedEvent
                                    ? eventMembership
                                      ? `${selectedEvent.name}: ${eventMembership.roleKey} · ${eventMembership.participationStatus}`
                                      : `${selectedEvent.name}: not linked as a speaker`
                                    : "No selected event"}
                                </span>
                              </div>
                            </div>
                          </th>
                          <td data-label="Organization">
                            <span className={styles.cellValue}>{person.organization ?? "No organization"}</span>
                            <span className={styles.detailMuted}>Canonical field</span>
                          </td>
                          <td data-label="Canonical email">
                            <span className={styles.email}>{person.canonicalEmail}</span>
                            <span className={styles.detailMuted}>Profile link opens the existing canonical person record.</span>
                          </td>
                          <td data-label="Local stage">
                            {renderStageSelect(person, overlay, true)}
                            <span className={styles.fieldHelp}>{stageDescription(overlay.stage)}</span>
                          </td>
                          <td data-label="Tags">
                            <div className={styles.tagCell}>
                              <div className={styles.tagRow}>
                                {overlay.tags.map((tag) => (
                                  <button type="button" key={tag} className={styles.tag} onClick={() => removeTag(person.id, tag)} title={`Remove local tag ${tag}`}>
                                    {tag} ×
                                  </button>
                                ))}
                                {overlay.tags.length === 0 ? <span className={styles.emptyTag}>No local tags</span> : null}
                              </div>
                              <form className={styles.tagForm} onSubmit={(event) => addTag(event, person.id)}>
                                <label className={styles.visuallyHidden} htmlFor={`tag-${person.id}`}>Add local tag for {person.fullName}</label>
                                <input id={`tag-${person.id}`} type="text" maxLength={MAX_TAG_LENGTH} value={tagDrafts[person.id] ?? ""} placeholder="Add tag" onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  setTagDrafts((current) => ({ ...current, [person.id]: value }));
                                }} />
                                <button type="submit" className={styles.smallButton}>Add</button>
                              </form>
                            </div>
                          </td>
                          <td data-label="Note">
                            <label className={styles.noteColumn}>
                              <span className={styles.detailLabel}>Browser-local note</span>
                              <textarea value={overlay.note} maxLength={MAX_NOTE_LENGTH} placeholder="Add a reminder — never sent to a provider" aria-label={`Browser-local note for ${person.fullName}`} onChange={(event) => {
                                const note = event.currentTarget.value;
                                updateOverlay(person.id, (current) => ({ ...current, note }));
                              }} onBlur={() => setNotice("Note saved to this browser only; do not enter sensitive or regulated data.")} />
                              <span className={styles.fieldHelp}>{overlay.note.length}/{MAX_NOTE_LENGTH} characters</span>
                            </label>
                          </td>
                          <td data-label="History">
                            <details className={styles.history}>
                              <summary>Local stage history ({overlay.stageHistory.length})</summary>
                              <p className={styles.historyHint}>Synthetic CRM overlay history; it does not alter truth-layer or commitment records.</p>
                              {overlay.stageHistory.length > 0 ? (
                                <ol>
                                  {[...overlay.stageHistory].reverse().map((entry, historyIndex) => (
                                    <li key={`${entry.changedAt}-${historyIndex}`}><strong>{stageLabel(entry.from)} → {stageLabel(entry.to)}</strong><time dateTime={entry.changedAt}>{formatLocalDate(entry.changedAt)}</time></li>
                                  ))}
                                </ol>
                              ) : <span className={styles.emptyHistory}>No local stage transitions yet.</span>}
                            </details>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={styles.emptyState}>
                <strong>No canonical people match these filters.</strong>
                <span>Clear the local filters or import canonical People from the existing workspace workflow.</span>
              </div>
            )}
          </div>
        ) : (
          <div className={styles.board} aria-label="Local CRM pipeline board">
            {CRM_STAGES.map((stage) => {
              const columnPeople = filteredPeople.filter((person) => {
                const index = personIndexById.get(person.id) ?? 0;
                return overlayFor(person, index).stage === stage.id;
              });
              const visibleColumnPeople = peoplePage.items.filter((person) => {
                const index = personIndexById.get(person.id) ?? 0;
                return overlayFor(person, index).stage === stage.id;
              });
              return (
                <section key={stage.id} className={styles.boardColumn} aria-labelledby={`stage-${stage.id}`}>
                  <header className={styles.boardHeader}>
                    <div>
                      <h3 id={`stage-${stage.id}`}>{stage.label}</h3>
                      <p>{stage.description}</p>
                    </div>
                    <span className={styles.boardCount}>{columnPeople.length}</span>
                  </header>
                  <div className={styles.boardCards}>
                    {visibleColumnPeople.map((person) => {
                      const index = personIndexById.get(person.id) ?? 0;
                      const overlay = overlayFor(person, index);
                      return (
                        <article key={person.id} className={styles.boardCard}>
                          <div className={styles.boardCardTop}>
                            <span className={styles.miniAvatar} aria-hidden="true">{initials(person.fullName)}</span>
                            <div>
                              <Link href={`/w/${workspaceSlug}/people/${person.id}`}>{person.fullName}</Link>
                              <p>{person.organization ?? "No organization"}</p>
                            </div>
                          </div>
                          {overlay.tags.length > 0 ? (
                            <div className={styles.tagRow}>
                              {overlay.tags.map((tag) => <span className={styles.tagStatic} key={tag}>{tag}</span>)}
                            </div>
                          ) : null}
                          {overlay.note ? <p className={styles.boardNote}>{overlay.note}</p> : <p className={styles.boardNoteEmpty}>No local note</p>}
                          {renderStageSelect(person, overlay, true)}
                          <span className={styles.boardCardHint}>Stage movement is local and simulated.</span>
                        </article>
                      );
                    })}
                    {columnPeople.length === 0 ? <span className={styles.emptyColumn}>No matching people</span> : null}
                    {columnPeople.length > 0 && visibleColumnPeople.length === 0 ? <span className={styles.emptyColumn}>Matching people are on another page</span> : null}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </section>

      <footer className={styles.footerNote}>
        <strong>Prototype boundary:</strong> this bonus lane has no CRM-specific tables, provider
        synchronization, provider send, opportunity commitments, or destructive merge behavior. Confirmed
        synthetic imports append to the existing canonical People provenance spine. Event speaker links and
        PENDING local outbox evidence persist; notes, tags, segments, and stage movement remain browser-local.
      </footer>
    </div>
  );
}
