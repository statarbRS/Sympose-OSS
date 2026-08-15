import Link from "next/link";

import { Badge, Fingerprint, formatDateTime, type TruthTone } from "@/components/truth";
import type { SessionInfo } from "@/server/auth";
import type { Db } from "@/server/db";
import { getEventState } from "@/server/services/queries";
import { MAX_EVENTS_PER_WORKSPACE, listEvents, type EventRow } from "@/server/services/events";
import {
  queryInstitutionalMemory,
  type InstitutionalMemoryResult,
  type MemorySourceRecord,
} from "@/server/services/institutional-memory";
import {
  getManualSpeakerRecord,
  type ManualSpeakerRecord,
} from "@/server/services/speaker-operations/manual-speakers";

import styles from "./person-relationship-history.module.css";

type ProgramUnitReference = Readonly<{
  workspaceId: string;
  eventId: string;
  id: string;
  name: string;
}>;

type SpeakerRelationship = Pick<
  ManualSpeakerRecord,
  | "workspaceId"
  | "eventId"
  | "eventSpeakerId"
  | "personId"
  | "roleKey"
  | "participationStatus"
  | "participationStatusTrust"
  | "managementState"
  | "createdAt"
  | "provenance"
>;

export interface PersonHistoryEntry {
  readonly id: string;
  readonly badge: string;
  readonly tone: TruthTone;
  readonly title: string;
  readonly detail: string;
  readonly recordedAt: string;
  readonly currentUse: "current" | "historical" | "not-applicable";
  readonly authority: "evidence-only" | "historical-record" | "current-relationship";
  readonly fingerprint: string | null;
  readonly fingerprintOrigin: MemorySourceRecord["fingerprintOrigin"];
  readonly references: readonly Readonly<{ label: string; value: string }>[];
}

export interface PersonEventHistory {
  readonly event: EventRow;
  readonly entries: readonly PersonHistoryEntry[];
}

export interface PersonHistoryShowcase {
  readonly eventHistory: readonly PersonEventHistory[];
  readonly workspaceEvidence: readonly PersonHistoryEntry[];
  readonly unavailableFamilies: InstitutionalMemoryResult["unavailableFamilies"];
  readonly counts: Readonly<{
    events: number;
    applicationsAndProposals: number;
    proposalReviews: number;
    speakerRelationships: number;
    sessionObservations: number;
  }>;
}

export interface BuildPersonHistoryShowcaseInput {
  readonly expectedWorkspaceId: string;
  readonly expectedPersonId: string;
  readonly memory: InstitutionalMemoryResult;
  readonly events: readonly EventRow[];
  readonly programUnits: readonly ProgramUnitReference[];
  readonly speakerRelationships: readonly SpeakerRelationship[];
}

function dataText(source: MemorySourceRecord, key: string): string | null {
  const value = source.data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dataNumber(source: MemorySourceRecord, key: string): number | null {
  const value = source.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ").toLocaleLowerCase("en-US");
}

function referencesFor(source: MemorySourceRecord): PersonHistoryEntry["references"] {
  return Object.entries(source.ids)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([label, value]) => Object.freeze({ label, value }));
}

function memoryEntry(
  source: MemorySourceRecord,
  programUnitNames: ReadonlyMap<string, string>,
): PersonHistoryEntry {
  const common = {
    id: `${source.family}:${Object.entries(source.ids).sort().map(([key, value]) => `${key}:${value}`).join("|")}`,
    recordedAt: source.recordedAt,
    currentUse: source.currentUse,
    authority: source.authority,
    fingerprint: source.fingerprint,
    fingerprintOrigin: source.fingerprintOrigin,
    references: referencesFor(source),
  } as const;

  switch (source.family) {
    case "lineage": {
      const relationship = dataText(source, "relationshipType");
      const reason = dataText(source, "reason");
      const guidanceVersion = dataNumber(source, "guidanceVersion");
      return Object.freeze({
        ...common,
        badge: "Proposal lineage",
        tone: "candidate",
        title: relationship
          ? `Proposal relationship · ${humanize(relationship)}`
          : guidanceVersion
            ? `Proposal guidance · version ${guidanceVersion}`
            : "Proposal lineage evidence",
        detail: reason
          ? `Persisted lineage reason: ${reason}`
          : "Persisted relationship evidence; no free-text reason is exposed for this record.",
      });
    }
    case "submission-revision": {
      const revision = dataNumber(source, "revisionNumber");
      return Object.freeze({
        ...common,
        badge: "Application / proposal",
        tone: "candidate",
        title: revision ? `Application or proposal revision ${revision}` : "Application or proposal revision",
        detail: `${source.currentUse === "current" ? "Current" : "Historical"} immutable revision. A submission does not imply selection, assignment, or attendance.`,
      });
    }
    case "review-history": {
      const revision = dataNumber(source, "revisionNumber");
      const latest = dataNumber(source, "latestRevisionNumber");
      return Object.freeze({
        ...common,
        badge: "Proposal reviewed",
        tone: "neutral",
        title: revision ? `Review history revision ${revision}${latest ? ` of ${latest}` : ""}` : "Review history",
        detail: "Metadata for a review of this person’s proposal. Reviewer identity, evaluation content, and notes are intentionally not exposed here; this does not mean the selected person acted as a reviewer.",
      });
    }
    case "decision-outcome": {
      const kind = dataText(source, "kind");
      if (kind === "operational-outcome") {
        const observationType = dataText(source, "observationType") ?? "recorded outcome";
        const programUnitId = source.ids.programUnitId;
        const programUnit = programUnitId ? programUnitNames.get(programUnitId) : null;
        const observationSource = dataText(source, "source");
        return Object.freeze({
          ...common,
          badge: "Operational evidence",
          tone: "active",
          title: `Operational observation · ${humanize(observationType)}`,
          detail: `${programUnit ? `Session: ${programUnit}. ` : ""}${observationSource ? `Persisted source: ${observationSource}. ` : ""}Only the recorded observation type is shown; no broader attendance or performance fact is inferred.`,
        });
      }
      const decision = dataText(source, "decision") ?? "recorded";
      return Object.freeze({
        ...common,
        badge: "Organizer decision",
        tone: "approved",
        title: `Plan decision · ${humanize(decision)}`,
        detail: "Persisted decision history. It does not establish participant commitment, attendance, or performance.",
      });
    }
    case "person-history": {
      const provider = dataText(source, "provider") ?? "source";
      const sourceRef = dataText(source, "sourceRef");
      const version = dataNumber(source, "version");
      const linkDecision = dataText(source, "linkDecision");
      return Object.freeze({
        ...common,
        badge: "Source evidence",
        tone: "neutral",
        title: `${provider}${sourceRef ? ` · ${sourceRef}` : ""}${version ? ` · v${version}` : ""}`,
        detail: `${linkDecision ? `Link decision: ${linkDecision}. ` : ""}The bounded history uses the persisted payload fingerprint; it does not reproduce the provider payload.`,
      });
    }
    case "near-miss-snapshot": {
      const cohortName = dataText(source, "cohortName") ?? "cohort";
      const rank = dataNumber(source, "rank");
      const whyIn = dataText(source, "whyIn");
      return Object.freeze({
        ...common,
        badge: "Historical cohort",
        tone: "qualified",
        title: `${cohortName}${rank ? ` · rank ${rank}` : ""}`,
        detail: `${whyIn ?? "Persisted snapshot membership evidence."} This historical snapshot does not confer current eligibility or authority and has no persisted event binding.`,
      });
    }
  }
}

function speakerEntry(record: SpeakerRelationship): PersonHistoryEntry {
  const trusted = record.participationStatusTrust === "TRUSTED";
  return Object.freeze({
    id: `speaker:${record.eventSpeakerId}`,
    badge: "Speaker relationship",
    tone: trusted ? "accepted" : "neutral",
    title: `${humanize(record.roleKey)} · ${humanize(record.participationStatus)}`,
    detail: `${trusted ? "Persisted event-participation state" : "Unverified persisted event relationship"}; this does not establish session attendance or role performance. ${record.provenance.sourceRecordId ? `Provenance source version ${record.provenance.sourceVersion ?? "unknown"}.` : "No manual source-record provenance is available for this relationship."}`,
    recordedAt: record.createdAt,
    currentUse: "current",
    authority: "current-relationship",
    fingerprint: null,
    fingerprintOrigin: "not-stored",
    references: Object.freeze([
      Object.freeze({ label: "eventSpeakerId", value: record.eventSpeakerId }),
      ...(record.provenance.sourceRecordId
        ? [Object.freeze({ label: "sourceRecordId", value: record.provenance.sourceRecordId })]
        : []),
    ]),
  });
}

function newestFirst(left: PersonHistoryEntry, right: PersonHistoryEntry): number {
  return right.recordedAt.localeCompare(left.recordedAt) || left.id.localeCompare(right.id, "en-US");
}

export function buildPersonHistoryShowcase(
  input: BuildPersonHistoryShowcaseInput,
): PersonHistoryShowcase {
  if (
    input.memory.workspaceId !== input.expectedWorkspaceId ||
    input.memory.personId !== input.expectedPersonId ||
    input.memory.lineageId !== null
  ) {
    throw new Error("Person history projection scope mismatch.");
  }

  const eventById = new Map(input.events.map((event) => [event.id, event]));
  if (eventById.size !== input.events.length) {
    throw new Error("Person history event projection is ambiguous.");
  }
  for (const unit of input.programUnits) {
    if (unit.workspaceId !== input.expectedWorkspaceId || !eventById.has(unit.eventId)) {
      throw new Error("Program unit scope mismatch.");
    }
  }
  const entriesByEvent = new Map<string, PersonHistoryEntry[]>();
  const workspaceEvidence: PersonHistoryEntry[] = [];

  for (const source of input.memory.sources) {
    const eventProgramUnits = new Map<string, string>();
    if (source.eventId !== null) {
      if (!eventById.has(source.eventId)) {
        throw new Error("Person history references an event outside the authorized projection.");
      }
      for (const unit of input.programUnits) {
        if (unit.eventId === source.eventId) eventProgramUnits.set(unit.id, unit.name);
      }
    }
    const entry = memoryEntry(source, eventProgramUnits);
    if (source.eventId === null) {
      workspaceEvidence.push(entry);
    } else {
      const entries = entriesByEvent.get(source.eventId) ?? [];
      entries.push(entry);
      entriesByEvent.set(source.eventId, entries);
    }
  }

  for (const speaker of input.speakerRelationships) {
    if (
      speaker.workspaceId !== input.expectedWorkspaceId ||
      speaker.personId !== input.expectedPersonId ||
      !eventById.has(speaker.eventId)
    ) {
      throw new Error("Speaker relationship scope mismatch.");
    }
    const entries = entriesByEvent.get(speaker.eventId) ?? [];
    entries.push(speakerEntry(speaker));
    entriesByEvent.set(speaker.eventId, entries);
  }

  const eventHistory = input.events
    .map((event) => Object.freeze({
      event,
      entries: Object.freeze([...(entriesByEvent.get(event.id) ?? [])].sort(newestFirst)),
    }))
    .sort((left, right) =>
      right.event.startsAt.localeCompare(left.event.startsAt) ||
      left.event.id.localeCompare(right.event.id, "en-US"),
    );
  const involvedEventIds = new Set(
    eventHistory.filter((history) => history.entries.length > 0).map((history) => history.event.id),
  );

  return Object.freeze({
    eventHistory: Object.freeze(eventHistory),
    workspaceEvidence: Object.freeze(workspaceEvidence.sort(newestFirst)),
    unavailableFamilies: input.memory.unavailableFamilies,
    counts: Object.freeze({
      events: involvedEventIds.size,
      applicationsAndProposals: input.memory.sources.filter((source) =>
        source.family === "submission-revision" || source.family === "lineage",
      ).length,
      proposalReviews: input.memory.sources.filter((source) => source.family === "review-history").length,
      speakerRelationships: input.speakerRelationships.length,
      sessionObservations: input.memory.sources.filter((source) =>
        source.family === "decision-outcome" && source.data.kind === "operational-outcome" &&
        typeof source.ids.programUnitId === "string",
      ).length,
    }),
  });
}

export function loadPersonHistoryShowcase(
  db: Db,
  session: SessionInfo,
  workspaceSlug: string,
  personId: string,
): PersonHistoryShowcase {
  const memory = queryInstitutionalMemory(db, session, { workspaceSlug, personId });
  const events = listEvents(db, session.workspaceId);
  // The existing event-creation service enforces this portfolio ceiling. Refuse a legacy or
  // trigger-bypassed database that would turn the per-event persisted reads below into an
  // unbounded page query rather than silently treating the extra events as absent.
  if (events.length > MAX_EVENTS_PER_WORKSPACE) {
    throw new Error("Person history event portfolio exceeds the bounded read limit.");
  }
  const programUnits = events.flatMap((event) =>
    getEventState(db, session.workspaceId, event.id).units.map((unit) => ({
      workspaceId: session.workspaceId,
      eventId: event.id,
      id: unit.id,
      name: unit.name,
    })),
  );
  const speakerRelationships = events.flatMap((event) => {
    const record = getManualSpeakerRecord(
      db,
      {
        kind: "organizer",
        workspaceId: session.workspaceId,
        eventId: event.id,
        actorId: session.accountId,
      },
      personId,
    );
    return record ? [record] : [];
  });

  return buildPersonHistoryShowcase({
    expectedWorkspaceId: session.workspaceId,
    expectedPersonId: personId,
    memory,
    events,
    programUnits,
    speakerRelationships,
  });
}

function HistoryEntry({ entry }: { readonly entry: PersonHistoryEntry }) {
  return (
    <li className={styles.entry}>
      <div className={styles.entryMarker} aria-hidden="true" />
      <div className={styles.entryBody}>
        <div className={styles.entryHeader}>
          <Badge tone={entry.tone}>{entry.badge}</Badge>
          <span className={styles.authority}>{entry.authority.replaceAll("-", " ")}</span>
          {entry.currentUse === "current" ? <span className={styles.current}>Current revision</span> : null}
        </div>
        <h4>{entry.title}</h4>
        <p>{entry.detail}</p>
        <dl className={styles.references} aria-label="Persisted references">
          {entry.references.map((reference) => (
            <div key={`${reference.label}:${reference.value}`}>
              <dt>{reference.label}</dt>
              <dd><code>{reference.value}</code></dd>
            </div>
          ))}
          {entry.fingerprint ? (
            <div>
              <dt>{entry.fingerprintOrigin === "stored" ? "Stored fingerprint" : "Derived fingerprint"}</dt>
              <dd><Fingerprint value={entry.fingerprint} /></dd>
            </div>
          ) : null}
        </dl>
      </div>
      <time dateTime={entry.recordedAt}>{formatDateTime(entry.recordedAt)}</time>
    </li>
  );
}

export function PersonHistoryShowcaseView({
  showcase,
  workspaceSlug,
}: {
  readonly showcase: PersonHistoryShowcase;
  readonly workspaceSlug: string;
}) {
  const totalEntries = showcase.eventHistory.reduce((sum, event) => sum + event.entries.length, 0) +
    showcase.workspaceEvidence.length;

  return (
    <section className={styles.section} aria-labelledby="relationship-history-title" data-testid="person-relationship-history">
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>Persisted relationships across operating contexts</p>
          <h2 id="relationship-history-title">Cross-event involvement</h2>
          <p className={styles.intro}>
            Applications and proposals, reviews of those proposals, speaker relationships, plan decisions,
            and operational observations are shown only when an authorized persisted projection supplies them.
          </p>
        </div>
        <span className={styles.total}>{totalEntries} persisted record{totalEntries === 1 ? "" : "s"}</span>
      </header>

      <dl className={styles.metrics} aria-label="Cross-event relationship summary">
        <div><dt>Events with history</dt><dd>{showcase.counts.events}</dd></div>
        <div><dt>Proposal records</dt><dd>{showcase.counts.applicationsAndProposals}</dd></div>
        <div><dt>Reviews received</dt><dd>{showcase.counts.proposalReviews}</dd></div>
        <div><dt>Speaker relationships</dt><dd>{showcase.counts.speakerRelationships}</dd></div>
        <div><dt>Session observations</dt><dd>{showcase.counts.sessionObservations}</dd></div>
      </dl>

      <aside className={styles.truthBoundary} aria-label="Relationship-history truth boundary">
        <strong>Read-only history, not inferred participation.</strong>
        <span> A proposal review means this person’s proposal was reviewed; it does not identify this person as a reviewer.</span>
        <span> A speaker or plan relationship does not prove attendance or performance.</span>
      </aside>

      {totalEntries === 0 ? (
        <p className={styles.empty}>
          No persisted cross-event relationship history is exposed for this canonical person. No participation,
          attendance, reviewer role, or notes are inferred from that absence.
        </p>
      ) : null}

      <div className={styles.eventStack}>
        {showcase.eventHistory.map(({ event, entries }) => (
          <article key={event.id} className={styles.eventCard}>
            <header className={styles.eventHeader}>
              <div>
                <p>{formatDateTime(event.startsAt)} · {event.timezone}</p>
                <h3><Link href={`/w/${workspaceSlug}/events/${event.id}/overview`}>{event.name}</Link></h3>
              </div>
              <Badge tone="neutral">{event.lifecycle}</Badge>
            </header>
            {entries.length > 0 ? (
              <ol className={styles.timeline} aria-label={`${event.name} relationship history`}>
                {entries.map((entry) => <HistoryEntry key={entry.id} entry={entry} />)}
              </ol>
            ) : (
              <p className={styles.eventEmpty}>
                No persisted application, proposal-review, speaker, decision, session-observation, or other
                relationship is exposed for this person in this event.
              </p>
            )}
          </article>
        ))}
        {showcase.eventHistory.length === 0 ? (
          <p className={styles.eventEmpty}>This workspace has no persisted events to compare.</p>
        ) : null}
      </div>

      <div className={styles.supportingGrid}>
        <section className={styles.supportingPanel} aria-labelledby="workspace-evidence-title">
          <h3 id="workspace-evidence-title">Workspace-level evidence</h3>
          <p>Source links and cohort snapshots remain eventless when the persisted projection has no event binding.</p>
          {showcase.workspaceEvidence.length > 0 ? (
            <ol className={styles.timeline}>
              {showcase.workspaceEvidence.map((entry) => <HistoryEntry key={entry.id} entry={entry} />)}
            </ol>
          ) : (
            <p className={styles.eventEmpty}>No additional workspace-level provenance is exposed.</p>
          )}
        </section>

        <section className={styles.supportingPanel} aria-labelledby="coverage-title">
          <h3 id="coverage-title">Known coverage limits</h3>
          <ul className={styles.coverageList}>
            <li>
              <strong>Reviewer role:</strong> no person-linked reviewer-role projection is available through the
              bounded read services used here, so reviewer participation is not inferred.
            </li>
            <li>
              <strong>Notes:</strong> persisted lineage reasons appear when available. Reviewer comments,
              evaluation content, and private note bodies are not exposed by this projection.
            </li>
            {showcase.unavailableFamilies.map((family) => (
              <li key={family.family}><strong>{family.family}:</strong> {family.reason}</li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}

export function PersonRelationshipHistory({
  db,
  session,
  workspaceSlug,
  personId,
}: {
  readonly db: Db;
  readonly session: SessionInfo;
  readonly workspaceSlug: string;
  readonly personId: string;
}) {
  const showcase = loadPersonHistoryShowcase(db, session, workspaceSlug, personId);
  return <PersonHistoryShowcaseView showcase={showcase} workspaceSlug={workspaceSlug} />;
}
