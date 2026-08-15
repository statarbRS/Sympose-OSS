export type AnalyticsSource<T> =
  | { readonly kind: "available"; readonly value: T }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface SubmissionCounts {
  readonly draft: number;
  readonly submitted: number;
  readonly withdrawn: number;
  readonly invalidated: number;
}

export interface ReviewCounts {
  readonly assigned: number;
  readonly inProgress: number;
  readonly submitted: number;
  readonly recused: number;
  readonly revoked: number;
  readonly activeTotal: number;
}

export interface SpeakerReadinessCounts {
  readonly ready: number;
  readonly evaluated: number;
}

export interface ScheduleCounts {
  readonly scheduled: number;
  readonly accepted: number;
}

export type PublicationState =
  | { readonly state: "healthy"; readonly sealedAt: string }
  | { readonly state: "not-published" };

export interface CrossEventAnalyticsInput {
  readonly event: {
    readonly id: string;
    readonly name: string;
    readonly lifecycle: string;
    readonly timezone: string;
  };
  readonly submissions: AnalyticsSource<SubmissionCounts>;
  readonly reviews: AnalyticsSource<ReviewCounts>;
  readonly speakers: AnalyticsSource<SpeakerReadinessCounts>;
  readonly schedule: AnalyticsSource<ScheduleCounts>;
  readonly publication: AnalyticsSource<PublicationState>;
}

export type AnalyticsMetricKey =
  | "submissions"
  | "reviews"
  | "speakers"
  | "schedule"
  | "publication";

export type MetricState = "available" | "empty" | "unavailable";

export interface EventMetricCell {
  readonly state: MetricState;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly percentage: number | null;
  readonly value: string;
  readonly detail: string;
  readonly components: Readonly<Record<string, number>>;
  readonly sourceTimestamp: string | null;
}

export interface EventAnalyticsRow {
  readonly event: CrossEventAnalyticsInput["event"];
  readonly metrics: Readonly<Record<AnalyticsMetricKey, EventMetricCell>>;
}

export interface MetricRollup {
  readonly key: AnalyticsMetricKey;
  readonly title: string;
  readonly eyebrow: string;
  readonly state: MetricState;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly percentage: number | null;
  readonly value: string;
  readonly numeratorLabel: string;
  readonly denominatorLabel: string;
  readonly definition: string;
  readonly boundary: string;
  readonly exclusions: string;
  readonly measuredEvents: number;
  readonly totalEvents: number;
  readonly partial: boolean;
  readonly components: Readonly<Record<string, number>>;
}

export interface CrossEventAnalyticsModel {
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  readonly events: readonly EventAnalyticsRow[];
  readonly metrics: readonly MetricRollup[];
}

interface MetricDefinition {
  readonly title: string;
  readonly eyebrow: string;
  readonly numeratorLabel: string;
  readonly denominatorLabel: string;
  readonly definition: string;
  readonly boundary: string;
  readonly exclusions: string;
  readonly emptyValue: string;
}

const METRIC_DEFINITIONS: Readonly<Record<AnalyticsMetricKey, MetricDefinition>> = {
  submissions: {
    title: "Submission funnel",
    eyebrow: "Current CFP state",
    numeratorLabel: "Submitted records",
    denominatorLabel: "All current submission records",
    definition: "Submitted current records divided by all current CFP submission records in measured calls.",
    boundary: "Current persisted submission state across this workspace's events and calls.",
    exclusions: "Draft, submitted, withdrawn, and invalidated are mutually exclusive current states; this is not a historical conversion or selection rate.",
    emptyValue: "No tracked submissions",
  },
  reviews: {
    title: "Reviewer throughput",
    eyebrow: "Independent review evidence",
    numeratorLabel: "Submitted assignments",
    denominatorLabel: "Active review assignments",
    definition: "Submitted review assignments divided by active assignments across measured review rounds.",
    boundary: "A current assignment-completion snapshot; each assignment in each round is counted once.",
    exclusions: "Recused and revoked assignments are excluded from the denominator. This is not reviews per hour, turnaround time, or an organizer decision.",
    emptyValue: "No active review assignments",
  },
  speakers: {
    title: "Speaker readiness",
    eyebrow: "Deterministic readiness",
    numeratorLabel: "Ready speakers",
    denominatorLabel: "Speakers evaluated by an authoritative readiness projection",
    definition: "Ready speakers divided by speakers evaluated by a durable, authoritative readiness projection.",
    boundary: "Current event-scoped speaker readiness in this workspace.",
    exclusions: "Roster membership, invitation delivery, commitment, task completion, and readiness are distinct facts.",
    emptyValue: "No evaluated speakers",
  },
  schedule: {
    title: "Accepted-session scheduling",
    eyebrow: "Accepted CFP handoff",
    numeratorLabel: "Accepted handoffs with a session allocation",
    denominatorLabel: "Accepted CFP decisions with a session handoff",
    definition: "Accepted CFP handoffs with one persisted session allocation divided by all accepted CFP handoffs.",
    boundary: "Current accepted CFP decisions and their linked-session allocation state.",
    exclusions: "This is not whole-program completion, schedule approval, publication, or attendance. Non-CFP program units are outside this denominator.",
    emptyValue: "No accepted CFP handoffs",
  },
  publication: {
    title: "Publication health",
    eyebrow: "Current sealed release",
    numeratorLabel: "Validated current releases",
    denominatorLabel: "Event publication states successfully evaluated",
    definition: "Events whose current sealed release passes the strict read validator divided by event publication states successfully evaluated.",
    boundary: "Current release pointers and immutable release evidence for workspace events.",
    exclusions: "An event without a current release is measured as not published. A pointer that cannot be validated is excluded and shown as unavailable, not treated as healthy or unpublished.",
    emptyValue: "No current releases",
  },
};

const METRIC_ORDER: readonly AnalyticsMetricKey[] = [
  "submissions",
  "reviews",
  "speakers",
  "schedule",
  "publication",
];

function safeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function unavailable(reason: string): EventMetricCell {
  return {
    state: "unavailable",
    numerator: null,
    denominator: null,
    percentage: null,
    value: "N/A",
    detail: reason,
    components: {},
    sourceTimestamp: null,
  };
}

function ratioCell(
  numerator: number,
  denominator: number,
  components: Readonly<Record<string, number>>,
  detail: string,
  emptyValue: string,
): EventMetricCell {
  if (!safeCount(numerator) || !safeCount(denominator) || numerator > denominator) {
    return unavailable("The persisted counts were internally inconsistent, so this metric was not calculated.");
  }
  if (denominator === 0) {
    return {
      state: "empty",
      numerator: 0,
      denominator: 0,
      percentage: null,
      value: emptyValue,
      detail,
      components,
      sourceTimestamp: null,
    };
  }
  const percentage = Math.round((numerator / denominator) * 100);
  return {
    state: "available",
    numerator,
    denominator,
    percentage,
    value: `${numerator} of ${denominator} · ${percentage}%`,
    detail,
    components,
    sourceTimestamp: null,
  };
}

function submissionCell(source: AnalyticsSource<SubmissionCounts>): EventMetricCell {
  if (source.kind === "unavailable") return unavailable(source.reason);
  const counts = source.value;
  const values = [counts.draft, counts.submitted, counts.withdrawn, counts.invalidated];
  if (!values.every(safeCount)) return unavailable("The persisted submission counts were invalid.");
  const denominator = values.reduce((sum, count) => sum + count, 0);
  return ratioCell(
    counts.submitted,
    denominator,
    { ...counts },
    `Draft ${counts.draft} · Submitted ${counts.submitted} · Withdrawn ${counts.withdrawn} · Invalidated ${counts.invalidated}`,
    METRIC_DEFINITIONS.submissions.emptyValue,
  );
}

function reviewCell(source: AnalyticsSource<ReviewCounts>): EventMetricCell {
  if (source.kind === "unavailable") return unavailable(source.reason);
  const counts = source.value;
  const values = [counts.assigned, counts.inProgress, counts.submitted, counts.recused, counts.revoked, counts.activeTotal];
  if (!values.every(safeCount) || counts.assigned + counts.inProgress + counts.submitted !== counts.activeTotal) {
    return unavailable("The persisted review-assignment counts were internally inconsistent.");
  }
  return ratioCell(
    counts.submitted,
    counts.activeTotal,
    { ...counts },
    `Assigned ${counts.assigned} · In progress ${counts.inProgress} · Submitted ${counts.submitted} · Excluded: ${counts.recused} recused, ${counts.revoked} revoked`,
    METRIC_DEFINITIONS.reviews.emptyValue,
  );
}

function speakerCell(source: AnalyticsSource<SpeakerReadinessCounts>): EventMetricCell {
  if (source.kind === "unavailable") return unavailable(source.reason);
  return ratioCell(
    source.value.ready,
    source.value.evaluated,
    { ...source.value },
    `${source.value.ready} ready of ${source.value.evaluated} authoritatively evaluated`,
    METRIC_DEFINITIONS.speakers.emptyValue,
  );
}

function scheduleCell(source: AnalyticsSource<ScheduleCounts>): EventMetricCell {
  if (source.kind === "unavailable") return unavailable(source.reason);
  return ratioCell(
    source.value.scheduled,
    source.value.accepted,
    { ...source.value },
    `${source.value.scheduled} scheduled · ${source.value.accepted - source.value.scheduled} unscheduled accepted handoffs`,
    METRIC_DEFINITIONS.schedule.emptyValue,
  );
}

function publicationCell(source: AnalyticsSource<PublicationState>): EventMetricCell {
  if (source.kind === "unavailable") return unavailable(source.reason);
  if (source.value.state === "not-published") {
    return {
      state: "empty",
      numerator: 0,
      denominator: 1,
      percentage: null,
      value: "Not published",
      detail: "No current sealed release pointer is recorded for this event.",
      components: { healthy: 0, notPublished: 1 },
      sourceTimestamp: null,
    };
  }
  return {
    state: "available",
    numerator: 1,
    denominator: 1,
    percentage: 100,
    value: "Current release validated",
    detail: "The current sealed release passed the strict release read validator.",
    components: { healthy: 1, notPublished: 0 },
    sourceTimestamp: source.value.sealedAt,
  };
}

function eventRow(input: CrossEventAnalyticsInput): EventAnalyticsRow {
  return {
    event: input.event,
    metrics: {
      submissions: submissionCell(input.submissions),
      reviews: reviewCell(input.reviews),
      speakers: speakerCell(input.speakers),
      schedule: scheduleCell(input.schedule),
      publication: publicationCell(input.publication),
    },
  };
}

function rollup(key: AnalyticsMetricKey, events: readonly EventAnalyticsRow[]): MetricRollup {
  const definition = METRIC_DEFINITIONS[key];
  const measured = events.map((event) => event.metrics[key]).filter((metric) => metric.state !== "unavailable");
  const numerator = measured.reduce((sum, metric) => sum + (metric.numerator ?? 0), 0);
  const denominator = measured.reduce((sum, metric) => sum + (metric.denominator ?? 0), 0);
  const components: Record<string, number> = {};
  for (const metric of measured) {
    for (const [name, count] of Object.entries(metric.components)) {
      components[name] = (components[name] ?? 0) + count;
    }
  }
  const base = {
    key,
    ...definition,
    measuredEvents: measured.length,
    totalEvents: events.length,
    partial: measured.length > 0 && measured.length < events.length,
    components,
  };
  if (events.length === 0 || measured.length === 0) {
    return { ...base, state: "unavailable", numerator: null, denominator: null, percentage: null, value: "N/A" };
  }
  if (denominator === 0 || (key === "publication" && numerator === 0)) {
    return { ...base, state: "empty", numerator, denominator, percentage: null, value: definition.emptyValue };
  }
  const percentage = Math.round((numerator / denominator) * 100);
  return {
    ...base,
    state: "available",
    numerator,
    denominator,
    percentage,
    value: `${numerator} of ${denominator} · ${percentage}%`,
  };
}

export function buildCrossEventAnalyticsModel(input: {
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  readonly events: readonly CrossEventAnalyticsInput[];
}): CrossEventAnalyticsModel {
  const events = input.events.map(eventRow);
  return {
    workspaceName: input.workspaceName,
    workspaceSlug: input.workspaceSlug,
    events,
    metrics: METRIC_ORDER.map((key) => rollup(key, events)),
  };
}
