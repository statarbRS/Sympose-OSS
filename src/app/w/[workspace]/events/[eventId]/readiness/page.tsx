import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  EventReadinessCommandCenter,
  type EventReadinessArea,
  type EventReadinessProjection,
  type ReadinessFinding,
  type ReadinessMetric,
  type ReadinessTone,
} from "@/components/event-readiness/event-readiness";
import { getDb } from "@/server/db";
import { listOffers } from "@/server/services/commitments";
import { readOrganizerReviewSurface } from "@/server/services/cfp-review/organizer";
import { readCfpOrganizerOverview } from "@/server/services/cfp/organizer";
import { getEvent } from "@/server/services/events";
import {
  validatePublicReleaseForRead,
  type ValidatedPublicRelease,
} from "@/server/services/publication";
import { detectScheduleConflicts } from "@/server/services/scheduling/deterministic";
import { readScheduleDraft } from "@/server/services/scheduling/persistence";
import { listSpeakerCommunicationDeliveryLog } from "@/server/services/speaker-communications";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

import { EventProductSurface } from "../_components/product-surface";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Event readiness" };

type ReadResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false }>;

interface CfpAggregate {
  readonly calls: number;
  readonly submissions: number;
  readonly draft: number;
  readonly submitted: number;
  readonly withdrawn: number;
  readonly invalidated: number;
}

interface ReviewAggregate {
  readonly rounds: number;
  readonly assignments: number;
  readonly submitted: number;
  readonly outstanding: number;
  readonly conflicts: number;
  readonly blindPending: number;
}

interface CommitmentAggregate {
  readonly total: number;
  readonly accepted: number;
  readonly declined: number;
  readonly awaiting: number;
  readonly unrecognized: number;
}

type ScheduleAggregate =
  | Readonly<{ persisted: false }>
  | Readonly<{
      persisted: true;
      status: string;
      sessions: number;
      scheduled: number;
      unscheduled: number;
      conflicts: number;
    }>;

type PublicationAggregate =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "invalid" }>
  | Readonly<{
      state: "current";
      accepted: number;
      agendas: number;
      audiencePolicyVersion: number;
      commitmentWatermark: number;
      sealedAt: string;
    }>;

interface CommunicationsAggregate {
  readonly total: number;
  readonly pending: number;
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly unrecognized: number;
}

function readSafely<T>(read: () => T): ReadResult<T> {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false };
  }
}

function metric(label: string, value: string | number): ReadinessMetric {
  return { label, value };
}

function finding(tone: ReadinessFinding["tone"], text: string): ReadinessFinding {
  return { tone, text };
}

function submissionsAndReviewArea(
  cfp: ReadResult<CfpAggregate>,
  review: ReadResult<ReviewAggregate>,
  baseHref: string,
): EventReadinessArea {
  const missingSources = Number(!cfp.ok) + Number(!review.ok);
  const metrics: ReadinessMetric[] = [];
  const findings: ReadinessFinding[] = [];

  if (cfp.ok) {
    metrics.push(
      metric("Calls", cfp.value.calls),
      metric("Submissions", cfp.value.submissions),
      metric("Submitted", cfp.value.submitted),
      metric("Draft", cfp.value.draft),
      metric("Withdrawn", cfp.value.withdrawn),
      metric("Invalidated", cfp.value.invalidated),
    );
    if (cfp.value.calls === 0) {
      findings.push(finding("attention", "No CFP call exists; confirm whether this event needs proposal intake."));
    }
    if (cfp.value.draft > 0) {
      findings.push(finding("attention", `${cfp.value.draft} submission draft${cfp.value.draft === 1 ? " is" : "s are"} still in progress.`));
    }
    if (cfp.value.invalidated > 0) {
      findings.push(finding("attention", `${cfp.value.invalidated} submission${cfp.value.invalidated === 1 ? " is" : "s are"} invalidated and should be inspected.`));
    }
  } else {
    findings.push(finding("unavailable", "Submission evidence could not be read from the CFP projection."));
  }

  if (review.ok) {
    metrics.push(
      metric("Review rounds", review.value.rounds),
      metric("Review evidence", `${review.value.submitted}/${review.value.assignments}`),
    );
    if (cfp.ok && cfp.value.submitted > 0 && review.value.rounds === 0) {
      findings.push(finding("attention", "Submitted proposals exist, but no review round is available."));
    }
    if (review.value.outstanding > 0) {
      findings.push(finding("attention", `${review.value.outstanding} active review assignment${review.value.outstanding === 1 ? " remains" : "s remain"} outstanding.`));
    }
    if (review.value.conflicts > 0) {
      findings.push(finding("attention", `${review.value.conflicts} declared review conflict${review.value.conflicts === 1 ? " needs" : "s need"} resolution.`));
    }
    if (review.value.blindPending > 0) {
      findings.push(finding("attention", `${review.value.blindPending} active review assignment${review.value.blindPending === 1 ? " lacks" : "s lack"} blind-review evidence.`));
    }
  } else {
    findings.push(finding("unavailable", "Review evidence could not be read from the organizer review projection."));
  }

  let tone: ReadinessTone = "ready";
  let statusLabel = "No open signals";
  if (missingSources > 0) {
    tone = "unavailable";
    statusLabel = missingSources === 2 ? "Evidence unavailable" : "Partial evidence";
  } else if (findings.some((item) => item.tone === "attention" || item.tone === "blocked")) {
    tone = "attention";
    statusLabel = "Needs attention";
  } else {
    findings.push(finding("note", "No outstanding submission or review signals were found in these projections."));
  }

  return {
    id: "submissions-review",
    title: "Submissions and review",
    eyebrow: "Candidate and review evidence",
    status: { tone, label: statusLabel },
    evidence: {
      state: missingSources === 0 ? "complete" : missingSources === 1 ? "partial" : "unavailable",
      label: missingSources === 0
        ? "CFP and review projections read for this event"
        : missingSources === 1
          ? "One of two server projections is unavailable"
          : "CFP and review projections are unavailable",
    },
    summary: "Submission states and review progress are counted independently; review evidence is not an organizer decision.",
    metrics,
    findings,
    actions: [
      { href: `${baseHref}/cfp`, label: "Open proposal intake" },
      { href: `${baseHref}/review`, label: "Open review console" },
    ],
  };
}

function speakerCommitmentsArea(
  commitments: ReadResult<CommitmentAggregate>,
  baseHref: string,
): EventReadinessArea {
  const metrics: ReadinessMetric[] = [];
  const findings: ReadinessFinding[] = [
    finding("unavailable", "Cannot verify speaker task readiness until the task evidence is available."),
  ];
  let tone: ReadinessTone = "unavailable";
  let statusLabel = "Cannot verify";

  if (commitments.ok) {
    metrics.push(
      metric("Current offers", commitments.value.total),
      metric("Accepted", commitments.value.accepted),
      metric("Awaiting", commitments.value.awaiting),
      metric("Declined", commitments.value.declined),
    );
    tone = "unavailable";
    statusLabel = "Cannot verify";
    if (commitments.value.total === 0) {
      tone = "attention";
      statusLabel = "No current offers";
      findings.unshift(finding("attention", "The current approved-plan offer projection returned no offers."));
    } else {
      if (commitments.value.awaiting > 0) {
        tone = "attention";
        statusLabel = "Needs attention";
        findings.unshift(finding("attention", `${commitments.value.awaiting} current-plan offer${commitments.value.awaiting === 1 ? " is" : "s are"} awaiting a response.`));
      }
      if (commitments.value.declined > 0) {
        tone = "attention";
        statusLabel = "Needs attention";
        findings.unshift(finding("attention", `${commitments.value.declined} current-plan offer${commitments.value.declined === 1 ? " was" : "s were"} declined.`));
      }
      if (commitments.value.unrecognized > 0) {
        tone = "unavailable";
        statusLabel = "Partial evidence";
        findings.unshift(finding("unavailable", "One or more offer responses are outside the recognized response projection."));
      }
    }
  } else {
    findings.unshift(finding("unavailable", "Current-plan commitment evidence could not be read."));
  }

  return {
    id: "speaker-commitments",
    title: "Speaker commitments and tasks",
    eyebrow: "Commitment evidence",
    status: { tone, label: statusLabel },
    evidence: {
      state: commitments.ok ? "partial" : "unavailable",
      label: commitments.ok
        ? "Current-plan responses read; task readiness unavailable"
        : "Commitment and task evidence unavailable",
    },
    summary: "Commitment responses come from the current approved plan. They do not stand in for speaker task completion.",
    metrics,
    findings,
    actions: [{ href: `${baseHref}/speakers#readiness-matrix-title`, label: "Open speaker readiness" }],
  };
}

function contentAndArtifactsArea(baseHref: string): EventReadinessArea {
  return {
    id: "content-artifacts",
    title: "Content and artifacts",
    eyebrow: "Operational evidence",
    status: { tone: "unavailable", label: "Evidence unavailable" },
    evidence: {
      state: "unavailable",
      label: "No safe canonical unified read on this base",
    },
    summary: "Current content-task and complete artifact readiness cannot be truthfully aggregated from a read-only canonical projection yet.",
    metrics: [],
    findings: [
      finding("unavailable", "Content status is withheld because the available unified projection is synthetic."),
      finding("unavailable", "Artifact totals are withheld because the broad artifact loader may perform recovery writes."),
    ],
    actions: [
      { href: `${baseHref}/speakers#content-review-title`, label: "Open content review" },
      { href: `${baseHref}/speakers#deliverables-title`, label: "Open deliverables" },
    ],
  };
}

function scheduleArea(schedule: ReadResult<ScheduleAggregate>, baseHref: string): EventReadinessArea {
  const programHref = `${baseHref}/program`;
  if (!schedule.ok || !schedule.value.persisted) {
    return {
      id: "schedule",
      title: "Schedule conflicts and placement",
      eyebrow: "Operational draft",
      status: { tone: "unavailable", label: schedule.ok ? "No saved draft" : "Evidence unavailable" },
      evidence: {
        state: "unavailable",
        label: schedule.ok ? "No persisted schedule draft evidence" : "Schedule projection unavailable",
      },
      summary: "Conflict and unscheduled counts are shown only for a saved event-scoped schedule draft.",
      metrics: [],
      findings: [
        finding(
          "unavailable",
          schedule.ok
            ? "The schedule loader returned no saved draft; synthetic fixture counts are intentionally omitted."
            : "The saved schedule draft could not be read.",
        ),
      ],
      actions: [{ href: programHref, label: "Open program schedule" }],
    };
  }

  const tone: ReadinessTone = schedule.value.conflicts > 0
    ? "blocked"
    : schedule.value.unscheduled > 0
      ? "attention"
      : "ready";
  const findings: ReadinessFinding[] = [];
  if (schedule.value.conflicts > 0) {
    findings.push(finding("blocked", `${schedule.value.conflicts} hard schedule conflict${schedule.value.conflicts === 1 ? " blocks" : "s block"} a clean draft.`));
  }
  if (schedule.value.unscheduled > 0) {
    findings.push(finding("attention", `${schedule.value.unscheduled} session${schedule.value.unscheduled === 1 ? " is" : "s are"} not placed.`));
  }
  if (findings.length === 0) {
    findings.push(finding("note", "Every session in the saved draft is placed and no hard overlap was detected."));
  }

  return {
    id: "schedule",
    title: "Schedule conflicts and placement",
    eyebrow: "Operational draft",
    status: {
      tone,
      label: tone === "blocked" ? "Hard conflict" : tone === "attention" ? "Needs attention" : "Draft clear",
    },
    evidence: { state: "complete", label: "Persisted schedule draft read for this event" },
    summary: "Deterministic hard-overlap checks and placement counts are derived from the saved draft, not a publication release.",
    metrics: [
      metric("Draft state", schedule.value.status),
      metric("Sessions", schedule.value.sessions),
      metric("Scheduled", schedule.value.scheduled),
      metric("Unscheduled", schedule.value.unscheduled),
      metric("Hard conflicts", schedule.value.conflicts),
    ],
    findings,
    actions: [
      { href: `${programHref}#schedule-conflicts-title`, label: "Inspect conflicts" },
      { href: `${programHref}#unscheduled-title`, label: "Place sessions" },
    ],
  };
}

function publicationArea(
  publication: ReadResult<PublicationAggregate>,
  baseHref: string,
): EventReadinessArea {
  const publicationHref = `${baseHref}/publication`;
  if (!publication.ok) {
    return {
      id: "publication",
      title: "Publication release",
      eyebrow: "Audience projection",
      status: { tone: "unavailable", label: "Evidence unavailable" },
      evidence: { state: "unavailable", label: "Publication release projection unavailable" },
      summary: "Only a strictly validated current sealed release can be reported here.",
      metrics: [],
      findings: [finding("unavailable", "The current publication release could not be read.")],
      actions: [{ href: publicationHref, label: "Open publication" }],
    };
  }

  if (publication.value.state === "absent") {
    return {
      id: "publication",
      title: "Publication release",
      eyebrow: "Audience projection",
      status: { tone: "attention", label: "Not published" },
      evidence: { state: "complete", label: "No current release pointer for this event" },
      summary: "No immutable audience release is currently selected for this event.",
      metrics: [],
      findings: [finding("attention", "Review publication readiness before sealing an audience release.")],
      actions: [{ href: publicationHref, label: "Open publication" }],
    };
  }

  if (publication.value.state === "invalid") {
    return {
      id: "publication",
      title: "Publication release",
      eyebrow: "Audience projection",
      status: { tone: "blocked", label: "Release unavailable" },
      evidence: { state: "unavailable", label: "Current release pointer failed strict validation" },
      summary: "A release pointer exists, but its sealed evidence cannot be validated for current access.",
      metrics: [],
      findings: [finding("blocked", "Publication evidence failed closed; no release counts are shown.")],
      actions: [{ href: publicationHref, label: "Inspect publication" }],
    };
  }

  return {
    id: "publication",
    title: "Publication release",
    eyebrow: "Audience projection",
    status: { tone: "ready", label: "Current release sealed" },
    evidence: { state: "complete", label: `Strictly validated release sealed ${publication.value.sealedAt}` },
    summary: "Counts come from the immutable current audience release and its exact commitment watermark.",
    metrics: [
      metric("Accepted", publication.value.accepted),
      metric("Personal agendas", publication.value.agendas),
      metric("Audience policy", `v${publication.value.audiencePolicyVersion}`),
      metric("Commitment watermark", publication.value.commitmentWatermark),
    ],
    findings: [finding("note", "Supersession or access-token revocation would not rewrite this sealed release.")],
    actions: [{ href: publicationHref, label: "Open publication" }],
  };
}

function communicationsArea(
  communications: ReadResult<CommunicationsAggregate>,
  baseHref: string,
): EventReadinessArea {
  const communicationsHref = `${baseHref}/speakers#speaker-communications-history-title`;
  if (!communications.ok) {
    return {
      id: "communications",
      title: "Communications and outbox",
      eyebrow: "Operational evidence",
      status: { tone: "unavailable", label: "Evidence unavailable" },
      evidence: { state: "unavailable", label: "Local event outbox projection unavailable" },
      summary: "Only event-scoped local outbox status is aggregated; message content and recipients stay out of this surface.",
      metrics: [],
      findings: [finding("unavailable", "Communications evidence could not be read.")],
      actions: [{ href: communicationsHref, label: "Open communication history" }],
    };
  }

  let tone: ReadinessTone = "ready";
  let statusLabel = communications.value.total === 0 ? "No queued work" : "Outbox clear";
  const findings: ReadinessFinding[] = [];
  if (communications.value.failed > 0) {
    tone = "blocked";
    statusLabel = "Delivery failures";
    findings.push(finding("blocked", `${communications.value.failed} local outbox message${communications.value.failed === 1 ? " has" : "s have"} failed.`));
  }
  if (communications.value.pending + communications.value.claimed > 0) {
    if (tone !== "blocked") tone = "attention";
    if (tone === "attention") statusLabel = "Work in progress";
    findings.push(finding("attention", `${communications.value.pending + communications.value.claimed} message${communications.value.pending + communications.value.claimed === 1 ? " is" : "s are"} pending or claimed locally.`));
  }
  if (communications.value.unrecognized > 0) {
    tone = "unavailable";
    statusLabel = "Partial evidence";
    findings.push(finding("unavailable", "One or more outbox rows have an unrecognized delivery status."));
  }
  if (communications.value.total === 0) {
    findings.push(finding("note", "No local outbox messages exist for this event; this does not imply that communication was required."));
  } else if (findings.length === 0) {
    findings.push(finding("note", "Every local outbox message in this event projection is delivered."));
  }

  return {
    id: "communications",
    title: "Communications and outbox",
    eyebrow: "Operational evidence",
    status: { tone, label: statusLabel },
    evidence: {
      state: communications.value.unrecognized > 0 ? "partial" : "complete",
      label: "Read-only local outbox; this page contacts no provider",
    },
    summary: "Delivery-state counts are aggregated without exposing recipient identities, destinations, subjects, or message previews.",
    metrics: [
      metric("Messages", communications.value.total),
      metric("Pending", communications.value.pending),
      metric("Processing", communications.value.claimed),
      metric("Delivered", communications.value.delivered),
      metric("Failed", communications.value.failed),
    ],
    findings,
    actions: [{ href: communicationsHref, label: "Open communication history" }],
  };
}

function currentPublicationAggregate(
  release: ValidatedPublicRelease | null,
): PublicationAggregate {
  if (release === null) return { state: "invalid" };
  return {
    state: "current",
    accepted: release.content.accepted.length,
    agendas: release.content.agendas.length,
    audiencePolicyVersion: release.audiencePolicyVersion,
    commitmentWatermark: release.commitmentWatermark,
    sealedAt: release.sealedAt,
  };
}

export default async function EventReadinessPage({
  params,
}: {
  readonly params: Promise<{ workspace: string; eventId: string }>;
}) {
  const { workspace, eventId } = await params;
  const session = requireOrganizerWorkspaceRoute(await getRouteSession(), workspace);
  const db = getDb();
  const event = getEvent(db, session.workspaceId, eventId);
  if (!event) notFound();

  const cfp = readSafely<CfpAggregate>(() => {
    const overview = readCfpOrganizerOverview(db, session, event.id);
    if (overview.event.id !== event.id) throw new Error("READ_SCOPE_MISMATCH");
    const counts = overview.calls.reduce(
      (total, call) => ({
        draft: total.draft + call.submissionCounts.draft,
        submitted: total.submitted + call.submissionCounts.submitted,
        withdrawn: total.withdrawn + call.submissionCounts.withdrawn,
        invalidated: total.invalidated + call.submissionCounts.invalidated,
      }),
      { draft: 0, submitted: 0, withdrawn: 0, invalidated: 0 },
    );
    return {
      calls: overview.calls.length,
      submissions: counts.draft + counts.submitted + counts.withdrawn + counts.invalidated,
      ...counts,
    };
  });

  const review = readSafely<ReviewAggregate>(() => {
    const surface = readOrganizerReviewSurface(db, session, {
      workspaceSlug: session.workspaceSlug,
      eventId: event.id,
    });
    if (
      surface.workspaceId !== session.workspaceId ||
      surface.workspaceSlug !== session.workspaceSlug ||
      surface.eventId !== event.id
    ) {
      throw new Error("READ_SCOPE_MISMATCH");
    }
    return surface.rounds.reduce<ReviewAggregate>(
      (total, round) => ({
        rounds: total.rounds + 1,
        assignments: total.assignments + round.progress.total,
        submitted: total.submitted + round.progress.submitted,
        outstanding: total.outstanding + Math.max(0, round.progress.total - round.progress.submitted),
        conflicts: total.conflicts + round.progress.conflicts,
        blindPending: total.blindPending + round.progress.blindPending,
      }),
      { rounds: 0, assignments: 0, submitted: 0, outstanding: 0, conflicts: 0, blindPending: 0 },
    );
  });

  const commitments = readSafely<CommitmentAggregate>(() => {
    const offers = listOffers(db, session.workspaceId, event.id);
    if (offers.some((offer) => offer.eventId !== event.id)) throw new Error("READ_SCOPE_MISMATCH");
    return offers.reduce<CommitmentAggregate>(
      (total, offer) => ({
        total: total.total + 1,
        accepted: total.accepted + Number(offer.response === "accepted"),
        declined: total.declined + Number(offer.response === "declined"),
        awaiting: total.awaiting + Number(offer.response === null),
        unrecognized: total.unrecognized + Number(
          offer.response !== null && offer.response !== "accepted" && offer.response !== "declined",
        ),
      }),
      { total: 0, accepted: 0, declined: 0, awaiting: 0, unrecognized: 0 },
    );
  });

  const schedule = readSafely<ScheduleAggregate>(() => {
    const loaded = readScheduleDraft(db, { workspaceId: session.workspaceId, eventId: event.id });
    if (loaded.schedule.workspaceId !== session.workspaceId || loaded.schedule.eventId !== event.id) {
      throw new Error("READ_SCOPE_MISMATCH");
    }
    if (!loaded.persisted) return { persisted: false };
    const conflicts = detectScheduleConflicts(loaded.schedule);
    const unscheduled = loaded.schedule.sessions.filter((item) => item.placement === null).length;
    return {
      persisted: true,
      status: loaded.schedule.status,
      sessions: loaded.schedule.sessions.length,
      scheduled: loaded.schedule.sessions.length - unscheduled,
      unscheduled,
      conflicts: conflicts.length,
    };
  });

  const currentReleaseId = event.currentReleaseId;
  const publication = currentReleaseId === null
    ? readSafely<PublicationAggregate>(() => ({ state: "absent" }))
    : readSafely<PublicationAggregate>(() => {
      const release = validatePublicReleaseForRead(db, {
        workspaceId: session.workspaceId,
        eventId: event.id,
        releaseId: currentReleaseId,
        mode: "CURRENT",
      });
      if (
        release !== null &&
        (release.workspaceId !== session.workspaceId || release.eventId !== event.id)
      ) {
        throw new Error("READ_SCOPE_MISMATCH");
      }
      return currentPublicationAggregate(release);
    });

  const communications = readSafely<CommunicationsAggregate>(() => {
    const entries = listSpeakerCommunicationDeliveryLog(db, {
      workspaceId: session.workspaceId,
      eventId: event.id,
    });
    if (entries.some((entry) => entry.workspaceId !== session.workspaceId || entry.eventId !== event.id)) {
      throw new Error("READ_SCOPE_MISMATCH");
    }
    return entries.reduce<CommunicationsAggregate>(
      (total, entry) => ({
        total: total.total + 1,
        pending: total.pending + Number(entry.status === "PENDING"),
        claimed: total.claimed + Number(entry.status === "CLAIMED"),
        delivered: total.delivered + Number(entry.status === "DELIVERED"),
        failed: total.failed + Number(entry.status === "FAILED"),
        unrecognized: total.unrecognized + Number(
          entry.status !== "PENDING" &&
          entry.status !== "CLAIMED" &&
          entry.status !== "DELIVERED" &&
          entry.status !== "FAILED",
        ),
      }),
      { total: 0, pending: 0, claimed: 0, delivered: 0, failed: 0, unrecognized: 0 },
    );
  });

  const baseHref = `/w/${session.workspaceSlug}/events/${event.id}`;
  const projection: EventReadinessProjection = {
    event: {
      id: event.id,
      name: event.name,
      timezone: event.timezone,
      lifecycle: event.lifecycle,
    },
    areas: [
      submissionsAndReviewArea(cfp, review, baseHref),
      speakerCommitmentsArea(commitments, baseHref),
      contentAndArtifactsArea(baseHref),
      scheduleArea(schedule, baseHref),
      publicationArea(publication, baseHref),
      communicationsArea(communications, baseHref),
    ],
  };

  return (
    <EventProductSurface
      workspace={session.workspaceSlug}
      event={event}
      active="readiness"
      eyebrow="Event readiness"
      title="Readiness command center"
      description="A compact attention view over existing event-scoped projections, with direct paths to the surfaces that own each fact."
    >
      <EventReadinessCommandCenter projection={projection} />
    </EventProductSurface>
  );
}
