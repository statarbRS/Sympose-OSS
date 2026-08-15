import {
  EVALUATOR_COMPATIBILITY_CALL_SLUG,
  EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG,
  EVALUATOR_ASSIGNMENT_ID,
  EVALUATOR_CALL_SLUG,
  EVALUATOR_EVENT_ID,
  EVALUATOR_WORKSPACE_SLUG,
} from "@/server/evaluator-demo";
import { embedPath } from "@/app/embed/_paths";

const AUDIENCE_REFERENCE_PATTERN = /^aud1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const organizerEventBase = `/w/${EVALUATOR_WORKSPACE_SLUG}/events/${EVALUATOR_EVENT_ID}`;
const organizerEntryAnchor = "/#workspace-entry";
const reviewerEntryAnchor = "/#reviewer-entry";
const reviewerSessionRequiredAnchor = "/#reviewer-session-required";
const attendeeAgendaStatusAnchor = "/#attendee-agenda-status";

export interface WalkthroughRouteLink {
  readonly label: string;
  readonly href: string;
  readonly note: string;
}

export interface EvaluationArea {
  readonly id: string;
  readonly title: string;
  readonly count: number;
  readonly routeLinks: readonly WalkthroughRouteLink[];
  readonly checkpoints: readonly string[];
  readonly criteria: readonly string[];
}

export interface EvaluatorWalkthroughRoutes {
  readonly root: string;
  readonly organizerDashboard: string;
  readonly reviewerQueue: string;
  readonly reviewerAssignment: string;
  readonly publicCfp: string;
  readonly speakerCheckpoint: string;
  readonly attendeeAgenda: string;
  readonly organizer: {
    readonly cfp: string;
    readonly review: string;
    readonly speakers: string;
    readonly program: string;
    readonly publication: string;
  };
  readonly compatibility: {
    readonly organizerDashboard: string;
    readonly reviewerQueue: string;
    readonly reviewerAssignment: string;
    readonly publicCfp: string;
    readonly event: string;
    readonly sharedSpeakerEntry: string;
    readonly sharedAttendeeAgenda: string;
  };
  readonly publicWidgets: {
    readonly sessions: string;
    readonly speakers: string;
    readonly gallery: string;
    readonly agenda: string;
    readonly itinerary: string;
    readonly configure: string;
  } | null;
}

export interface EvaluatorWalkthroughContent {
  readonly routes: EvaluatorWalkthroughRoutes;
  readonly devflowGoldenPath: readonly WalkthroughRouteLink[];
  readonly compatibilityJourney: readonly WalkthroughRouteLink[];
  readonly organizerJourney: readonly WalkthroughRouteLink[];
  readonly publicWidgetSurfaces: readonly WalkthroughRouteLink[];
  readonly publisherTool: WalkthroughRouteLink | null;
  readonly evaluationAreas: readonly EvaluationArea[];
  readonly publicReleaseAvailable: boolean;
}

function validatedReleaseReference(value: string | null): string | null {
  if (value === null) return null;
  if (!AUDIENCE_REFERENCE_PATTERN.test(value)) {
    throw new Error("Evaluator public release reference is invalid.");
  }
  return value;
}

export function createEvaluatorWalkthroughRoutes(
  releaseReference: string | null,
): EvaluatorWalkthroughRoutes {
  const canonicalReference = validatedReleaseReference(releaseReference);
  const attendeeAgenda = canonicalReference
    ? `/events/${encodeURIComponent(canonicalReference)}/agenda`
    : attendeeAgendaStatusAnchor;
  const publicWidgets = canonicalReference
    ? {
        sessions: embedPath(canonicalReference, "/sessions"),
        speakers: embedPath(canonicalReference, "/speakers"),
        gallery: embedPath(canonicalReference, "/gallery"),
        agenda: embedPath(canonicalReference, "/agenda"),
        itinerary: embedPath(canonicalReference, "/itinerary"),
        configure: embedPath(canonicalReference, "/configure"),
      }
    : null;

  return {
    root: "/",
    organizerDashboard: `/w/${EVALUATOR_WORKSPACE_SLUG}/dashboard`,
    reviewerQueue: `/review/${EVALUATOR_WORKSPACE_SLUG}/queue`,
    reviewerAssignment: `/review/${EVALUATOR_WORKSPACE_SLUG}/assignments/${EVALUATOR_ASSIGNMENT_ID}`,
    publicCfp: `/cfp/${EVALUATOR_WORKSPACE_SLUG}/${EVALUATOR_CALL_SLUG}`,
    speakerCheckpoint: "/speaker/entry",
    attendeeAgenda,
    organizer: {
      cfp: `${organizerEventBase}/cfp`,
      review: `${organizerEventBase}/review`,
      speakers: `${organizerEventBase}/speakers`,
      program: `${organizerEventBase}/program`,
      publication: `${organizerEventBase}/publication`,
    },
    compatibility: {
      organizerDashboard: organizerEntryAnchor,
      reviewerQueue: reviewerEntryAnchor,
      reviewerAssignment: reviewerSessionRequiredAnchor,
      publicCfp: `/cfp/${EVALUATOR_COMPATIBILITY_WORKSPACE_SLUG}/${EVALUATOR_COMPATIBILITY_CALL_SLUG}`,
      event: organizerEntryAnchor,
      sharedSpeakerEntry: "/speaker/entry",
      sharedAttendeeAgenda: attendeeAgenda,
    },
    publicWidgets,
  };
}

function createDevflowGoldenPath(
  routes: EvaluatorWalkthroughRoutes,
): readonly WalkthroughRouteLink[] {
  return [
    {
      label: "DevFlow organizer entry",
      href: routes.compatibility.organizerDashboard,
      note: "Use Jordan Alvarez in the root organizer form; this link does not establish a session.",
    },
    {
      label: "DevFlow public CFP",
      href: routes.compatibility.publicCfp,
      note: "Open the real local applicant surface for Priya Raman and Marcus Okafor.",
    },
    {
      label: "DevFlow reviewer entry",
      href: routes.compatibility.reviewerQueue,
      note: "Use Sam Whitfield in the root reviewer form; this link does not establish a session.",
    },
    {
      label: "DevFlow assigned review",
      href: routes.compatibility.reviewerAssignment,
      note: "Enter the synthetic reviewer session first; the protected assignment route is not a session entry point.",
    },
    {
      label: "DevFlow speaker mechanism",
      href: routes.compatibility.sharedSpeakerEntry,
      note: "Open Priya Raman's canonical DevFlow assignment, durable tasks, and exact-version content workspace.",
    },
    {
      label: "Shared attendee mechanism",
      href: routes.compatibility.sharedAttendeeAgenda,
      note: "The current sealed release is opened through its opaque audience reference, or the landing page shows an honest unavailable state.",
    },
  ];
}

function createOrganizerJourney(
  routes: EvaluatorWalkthroughRoutes,
): readonly WalkthroughRouteLink[] {
  return [
    {
      label: "Organizer dashboard",
      href: routes.organizerDashboard,
      note: "Sign in at the root first; this is the Acme workspace landing page.",
    },
    {
      label: "CFP",
      href: routes.organizer.cfp,
      note: "Inspect the seeded call, form version, conditional field, and proposal states.",
    },
    {
      label: "Review",
      href: routes.organizer.review,
      note: "Inspect the organizer review room, sealed rubric, assignment, and reviewer progress.",
    },
    {
      label: "Speaker operations",
      href: routes.organizer.speakers,
      note: "Inspect canonical people, speaker commitments, readiness, and the local adapter boundary.",
    },
    {
      label: "Program builder",
      href: routes.organizer.program,
      note: "Inspect the multi-day schedule, rooms, tracks, conflicts, and deterministic assist control.",
    },
    {
      label: "Publication",
      href: routes.organizer.publication,
      note: "Preview a release, inspect redactions, and follow the handoff to the public result.",
    },
    {
      label: "Public result",
      href: routes.attendeeAgenda,
      note: "The attendee-facing agenda opens only from a validated current sealed-release reference.",
    },
  ];
}

function createPublicWidgetSurfaces(
  routes: EvaluatorWalkthroughRoutes,
): readonly WalkthroughRouteLink[] {
  if (!routes.publicWidgets) return [];
  return [
    {
      label: "Sessions",
      href: routes.publicWidgets.sessions,
      note: "Searchable session cards with title, description, time, room, format, track, and speakers.",
    },
    {
      label: "Speakers",
      href: routes.publicWidgets.speakers,
      note: "Public speaker directory with search, identity metadata, and detail links.",
    },
    {
      label: "Gallery",
      href: routes.publicWidgets.gallery,
      note: "Photo-forward speaker cards with public profile and published-session detail.",
    },
    {
      label: "Agenda",
      href: routes.publicWidgets.agenda,
      note: "Day-oriented agenda blocks with time, room, track, and session detail.",
    },
    {
      label: "Itinerary",
      href: routes.publicWidgets.itinerary,
      note: "Release-scoped browser-local schedule with add/remove and calendar-export controls.",
    },
  ];
}

function createPublisherTool(
  routes: EvaluatorWalkthroughRoutes,
): WalkthroughRouteLink | null {
  if (!routes.publicWidgets) return null;
  return {
    label: "Configure portable embed",
    href: routes.publicWidgets.configure,
    note: "Publisher-only presentation settings and snippet preview; this tool is not a content surface.",
  };
}

function criterionIds(prefix: string, count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`);
}

function createEvaluationAreas(
  routes: EvaluatorWalkthroughRoutes,
  publicWidgetSurfaces: readonly WalkthroughRouteLink[],
): readonly EvaluationArea[] {
  return [
    {
      id: "call-for-papers",
      title: "Call for papers",
      count: 18,
      routeLinks: [
        { label: "Open organizer CFP", href: routes.organizer.cfp, note: "Signed-in organizer route" },
        { label: "Open public CFP", href: routes.publicCfp, note: "Logged-out public route" },
      ],
      checkpoints: [
        "Inspect field types, required flags, choices, and the conditional workshop-plan rule in the organizer builder and public form.",
        "Use the seeded proposal states—Mina Park accepted, Noor Haddad submitted, and Iris Cole draft—as synthetic examples; verify only statuses the UI renders.",
        "Check visible validation, draft/resume, event scoping, decision, notification, and public read-only behavior. Record an absent control as absent, not as a pass.",
      ],
      criteria: criterionIds("CFP", 18),
    },
    {
      id: "abstract-management",
      title: "Abstract review",
      count: 14,
      routeLinks: [
        { label: "Open organizer review", href: routes.organizer.review, note: "Organizer evidence and results" },
        { label: "Open reviewer queue", href: routes.reviewerQueue, note: "Requires the reviewer session from root" },
        { label: "Open assigned review", href: routes.reviewerAssignment, note: "Seeded assignment route" },
      ],
      checkpoints: [
        "Inspect round, rubric, assignment, blind-artifact, progress, results, export, conflict, and reviewer-completion controls where visibly available.",
        "Use a fresh reviewer browser context and confirm the queue is scoped to the assigned synthetic proposal; compare with the organizer view.",
        "The fixture makes no AI-review claim. Record a visible no-AI observation unless the product itself exposes a separate AI score, rationale, and human override.",
      ],
      criteria: criterionIds("ABS", 14),
    },
    {
      id: "speaker-management",
      title: "Speaker management",
      count: 16,
      routeLinks: [
        { label: "Open speaker operations", href: routes.organizer.speakers, note: "Signed-in organizer route" },
        { label: "Open scoped speaker portal", href: routes.speakerCheckpoint, note: "Synthetic speaker-facing portal entry" },
      ],
      checkpoints: [
        "Inspect canonical-person roster fields, search/filter, commitment/readiness language, exact offer terms, scoped tasks, and profile/content controls.",
        "Confirm Priya Raman’s accepted DevFlow session and assigned tasks resolve through one canonical Person, event-speaker, assignment, and portal scope.",
        "Keep the durability boundary visible: tasks, profile/text versions, reviews, and artifact metadata persist in scoped local SQLite; PNG/PDF bytes persist in authenticated local filesystem storage, and no email or storage provider is connected.",
      ],
      criteria: criterionIds("SPK", 16),
    },
    {
      id: "content-management",
      title: "Content management",
      count: 14,
      routeLinks: [
        { label: "Open speaker operations", href: routes.organizer.speakers, note: "Organizer content/readiness boundary" },
        { label: "Open scoped speaker portal", href: routes.speakerCheckpoint, note: "Speaker-facing task and content portal" },
      ],
      checkpoints: [
        "Exercise visible task creation, profile/text submission, version, comment, approval, upload/download, history, and export controls on the organizer and speaker surfaces.",
        "Verify a bounded PNG/PDF through its authenticated artifact link. The metadata CSV intentionally excludes bytes and does not make the upload itself metadata-only.",
        "Task/version and exact review-decision evidence persist in scoped local SQLite; exact PNG/PDF bytes persist in authenticated local filesystem storage, with no malware scanner, SMTP, or provider delivery.",
      ],
      criteria: criterionIds("CNT", 14),
    },
    {
      id: "ai-agenda",
      title: "Agenda and scheduling",
      count: 8,
      routeLinks: [
        { label: "Open program builder", href: routes.organizer.program, note: "Signed-in organizer route" },
        { label: "Open publication", href: routes.organizer.publication, note: "Release preview and handoff" },
        { label: "Open attendee result", href: routes.attendeeAgenda, note: "Public agenda route" },
      ],
      checkpoints: [
        "Inspect the multi-day grid, time slots, rooms, tracks, unscheduled tray, conflict explanations, move/clear controls, and deterministic auto-schedule action.",
        "Follow publication readiness, sealed-release, redaction, and public-handoff language; compare one visible session across organizer and attendee surfaces.",
        "Program drafts persist to local SQLite; evaluator publication-console state remains browser-local. A click on either surface proves only the boundary stated by that route.",
      ],
      criteria: criterionIds("AIA", 8),
    },
    {
      id: "public-widgets",
      title: "Public widgets",
      count: 16,
      routeLinks: publicWidgetSurfaces,
      checkpoints: [
        "Exercise sessions search/filter/detail, speaker directory/search/detail, agenda day/detail, and itinerary add/remove/reload/export behavior.",
        "Open all five links above in a non-admin context; confirm each is populated and that the sealed-release notice remains visible.",
        "Compare a sample title, time, room, track, and speaker across at least two public surfaces and the attendee result; record mismatches as evidence.",
      ],
      criteria: criterionIds("EMB", 16),
    },
  ];
}

export function createEvaluatorWalkthroughContent(
  releaseReference: string | null,
): EvaluatorWalkthroughContent {
  const routes = createEvaluatorWalkthroughRoutes(releaseReference);
  const publicWidgetSurfaces = createPublicWidgetSurfaces(routes);
  const devflowGoldenPath = createDevflowGoldenPath(routes);
  return {
    routes,
    devflowGoldenPath,
    // Keep the existing name as a compatibility alias for callers already using the route map.
    compatibilityJourney: devflowGoldenPath,
    organizerJourney: createOrganizerJourney(routes),
    publicWidgetSurfaces,
    publisherTool: createPublisherTool(routes),
    evaluationAreas: createEvaluationAreas(routes, publicWidgetSurfaces),
    publicReleaseAvailable: routes.publicWidgets !== null,
  };
}

export const requiredCriterionCount = 86;
