import { getDb } from "@/server/db";
import {
  runAutomaticActionTaskReminderJob,
} from "@/server/services/speaker-operations";
import {
  isAuthorizedAutomaticReminderJobRequest,
} from "@/server/services/speaker-operations/reminder-job-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

/**
 * Cron/systemd entry point. The only configured adapter is the no-network simulated adapter;
 * enabling SMTP or a remote provider requires a separate implementation and review.
 */
export function POST(request: Request): Response {
  if (!isAuthorizedAutomaticReminderJobRequest(
    request,
    process.env.SYMPOSE_REMINDER_JOB_TOKEN,
  )) {
    return Response.json(
      { schema: "speaker-action-task-reminder-job-response/v1", error: "NOT_FOUND" },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }
  try {
    const receipt = runAutomaticActionTaskReminderJob(getDb());
    return Response.json(receipt, { status: 200, headers: NO_STORE_HEADERS });
  } catch {
    return Response.json(
      { schema: "speaker-action-task-reminder-job-response/v1", error: "REMINDER_JOB_UNAVAILABLE" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
