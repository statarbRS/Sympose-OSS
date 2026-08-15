import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getDb } from "@/server/db";
import { getEvent } from "@/server/services/events";
import { getRouteSession, requireOrganizerWorkspaceRoute } from "@/server/workspace-session";

import { EventProductSurface, SurfaceSection, styles } from "../_components/product-surface";

import overviewStyles from "./overview.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Event Overview · Sympose MVP" };

const eventWorkflowLinks = [
  { path: "readiness", label: "Readiness", description: "Inspect explicit attention areas and follow each finding to its owning workflow." },
  { path: "cfp", label: "Call for proposals", description: "Review the event's proposal intake and submission evidence." },
  { path: "review", label: "Review", description: "Open the reviewer workflow and its current evidence." },
  { path: "speakers", label: "Speakers", description: "Inspect speaker commitments, tasks, and deterministic readiness." },
  { path: "program", label: "Plan Studio", description: "Shape sessions, schedule, resources, and capacity." },
  { path: "plan", label: "Plan evidence", description: "Review the exact compiler record and appended approval history." },
  { path: "publication", label: "Publication", description: "Inspect audience release state and publication controls." },
  { path: "operations", label: "Operations", description: "Open the event-day operating surface." },
] as const;

function formatEventMoment(value: string, timeZone: string): string {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return value;
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(instant));
  } catch {
    return value;
  }
}

function shortReference(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export default async function EventOverviewPage({ params }: { params: Promise<{ workspace: string; eventId: string }> }) {
  const { workspace, eventId } = await params;
  const session = await getRouteSession();
  requireOrganizerWorkspaceRoute(session, workspace);
  const event = getEvent(getDb(), session.workspaceId, eventId);
  if (!event) notFound();
  const eventBase = `/w/${workspace}/events/${event.id}`;
  const formattedStart = formatEventMoment(event.startsAt, event.timezone);
  const formattedEnd = formatEventMoment(event.endsAt, event.timezone);
  const primaryAction = event.lifecycle === "live"
    ? { path: "operations", label: "Open operations" }
    : event.lifecycle === "published"
      ? { path: "publication", label: "Review publication" }
      : event.lifecycle === "planning" && event.currentPlanVersionId
        ? { path: "plan", label: "Review current plan" }
        : { path: "readiness", label: "Review attention" };
  const attentionItems = [
    {
      label: "Readiness index",
      state: "Inspect current signals",
      description: "Open the explicit event-scoped checks. This overview does not infer a readiness result.",
      path: "readiness",
      action: "Open Readiness",
    },
    {
      label: "Plan record",
      state: event.currentPlanVersionId ? "Current pointer recorded" : "No current pointer",
      description: event.currentPlanVersionId
        ? "Inspect the exact plan record and its appended decision history."
        : "Open Plans to inspect candidate history and determine the next planning step.",
      path: "plan",
      action: "Open plans",
    },
    {
      label: "Audience release",
      state: event.currentReleaseId ? "Current pointer recorded" : "No current pointer",
      description: event.currentReleaseId
        ? "Inspect the referenced release and its audience-specific publication state."
        : "Open Publication to inspect channels without assuming they are ready.",
      path: "publication",
      action: "Open publication",
    },
  ] as const;
  return (
    <EventProductSurface
      workspace={workspace}
      event={event}
      active="overview"
      eyebrow="Event Overview"
      title="Event overview"
      description="An attention-first command surface: inspect only the event state recorded here, then open the workflow that owns the next decision."
    >
      <div className={overviewStyles.content}>
        <section className={overviewStyles.attentionBand} aria-labelledby="event-command-title">
          <div>
            <p className={overviewStyles.eyebrow}>{event.lifecycle} event · Next command</p>
            <h2 id="event-command-title">{event.name}</h2>
            <p className={overviewStyles.eventSchedule}>
              <time dateTime={event.startsAt}>{formattedStart}</time>
              <span aria-hidden="true">→</span>
              <time dateTime={event.endsAt}>{formattedEnd}</time>
              <span>({event.timezone})</span>
            </p>
          </div>
          <Link className="btn btn--primary" href={`${eventBase}/${primaryAction.path}`}>{primaryAction.label}</Link>
        </section>

        <section className={overviewStyles.attentionSection} aria-labelledby="attention-title">
          <div className={overviewStyles.attentionHeading}>
            <div>
              <p className={overviewStyles.eyebrow}>Needs attention / next decisions</p>
              <h2 id="attention-title">Open the record that can answer the question</h2>
            </div>
            <p>States below come only from the event record and its current pointers.</p>
          </div>
          <div className={overviewStyles.attentionGrid}>
            {attentionItems.map((item) => (
              <Link className={overviewStyles.attentionCard} href={`${eventBase}/${item.path}`} key={item.path}>
                <span className={overviewStyles.attentionLabel}>{item.label}</span>
                <strong>{item.state}</strong>
                <p>{item.description}</p>
                <span className={overviewStyles.attentionAction}>{item.action}<span aria-hidden="true">→</span></span>
              </Link>
            ))}
          </div>
        </section>

        <div className={overviewStyles.sectionGrid}>
          <SurfaceSection title="Event workflows">
            <p className={overviewStyles.sectionIntro}>Every destination keeps its own facts and actions.</p>
            <nav aria-label="Event workflow destinations">
              <ul className={overviewStyles.workflowGrid}>
                {eventWorkflowLinks.map(({ path, label, description }) => (
                  <li key={path}>
                    <Link className={overviewStyles.workflowLink} href={`${eventBase}/${path}`}>
                      <span><strong>{label}</strong><small>{description}</small></span>
                      <span aria-hidden="true">→</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </SurfaceSection>
          <SurfaceSection title="Event record">
            <dl className={`${styles.definitionGrid} ${overviewStyles.recordGrid}`}>
              <div><dt>Event</dt><dd>{event.name}</dd></div>
              <div><dt>Lifecycle</dt><dd>{event.lifecycle}</dd></div>
              <div><dt>Schedule</dt><dd><time dateTime={event.startsAt}>{formattedStart}</time><br /><span aria-hidden="true">→ </span><time dateTime={event.endsAt}>{formattedEnd}</time><br />{event.timezone}</dd></div>
              <div><dt>Current plan pointer</dt><dd>{event.currentPlanVersionId ? <Link href={`${eventBase}/plan`} title={event.currentPlanVersionId}><code>{shortReference(event.currentPlanVersionId)}</code></Link> : "None recorded"}</dd></div>
              <div><dt>Current release pointer</dt><dd>{event.currentReleaseId ? <Link href={`${eventBase}/publication`} title={event.currentReleaseId}><code>{shortReference(event.currentReleaseId)}</code></Link> : "None recorded"}</dd></div>
            </dl>
          </SurfaceSection>
        </div>
      </div>
    </EventProductSurface>
  );
}
