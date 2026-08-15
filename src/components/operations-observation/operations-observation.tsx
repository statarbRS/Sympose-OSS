import type { OperationsObservationSurface } from "@/server/services/outcomes";

import styles from "./operations-observation.module.css";

const RESULT_MESSAGES: Readonly<Record<string, { readonly tone: "success" | "error"; readonly message: string }>> = {
  "record-created": { tone: "success", message: "The attendance receipt is present in durable operational history." },
  "record-replayed": { tone: "success", message: "The attendance receipt remains the one durable observation; no duplicate exists." },
  "record-closed": { tone: "error", message: "This event is closed. New attendance cannot be added, but an existing observation may still be corrected." },
  "record-not-live": { tone: "error", message: "New attendance is available only while the event is live." },
  "record-time-invalid": { tone: "error", message: "The occurrence time must be within this live session and cannot be later than ingestion." },
  "record-invalid": { tone: "error", message: "That attendance target is not available in the current accepted program." },
  "record-conflict": { tone: "error", message: "Attendance history for that target is ambiguous or conflicts with the durable record." },
  "record-unavailable": { tone: "error", message: "Attendance recording is not available to this account." },
  "record-failed": { tone: "error", message: "Attendance could not be recorded. Reload and try again." },
  "correction-created": { tone: "success", message: "The correction receipt is present; the original remains visible and superseded." },
  "correction-replayed": { tone: "success", message: "The correction receipt remains the one durable lineage; no duplicate exists." },
  "correction-invalid": { tone: "error", message: "Use a printable correction reason between 8 and 280 characters." },
  "correction-conflict": { tone: "error", message: "That observation is already corrected differently or its history is ambiguous." },
  "correction-unavailable": { tone: "error", message: "That attendance observation is not available for correction." },
  "correction-failed": { tone: "error", message: "The correction could not be appended. Reload and try again." },
};

function formatTimestamp(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
      timeZoneName: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function OperationsObservation({
  surface,
  timezone,
  recordingAllowed,
  result,
  resultReceipt,
  recordAction,
  correctionAction,
}: {
  readonly surface: OperationsObservationSurface;
  readonly timezone: string;
  readonly recordingAllowed: boolean;
  readonly result: string | null;
  readonly resultReceipt: string | null;
  readonly recordAction: (formData: FormData) => Promise<void>;
  readonly correctionAction: (formData: FormData) => Promise<void>;
}) {
  const hasRecordEvidence = surface.lineages.some(
    (lineage) => lineage.originalObservationId === resultReceipt,
  );
  const hasCorrectionEvidence = surface.lineages.some(
    (lineage) => lineage.correction?.relationId === resultReceipt,
  );
  const resultIsEvidenceBacked =
    result === null ||
    !RESULT_MESSAGES[result] ||
    RESULT_MESSAGES[result].tone === "error" ||
    ((result === "record-created" || result === "record-replayed") && hasRecordEvidence) ||
    ((result === "correction-created" || result === "correction-replayed") && hasCorrectionEvidence);
  const resultMessage = result && resultIsEvidenceBacked ? RESULT_MESSAGES[result] : undefined;
  return (
    <div className={styles.surface} data-testid="operations-observation-surface">
      {resultMessage ? (
        <p
          className={styles.result}
          data-tone={resultMessage.tone}
          data-testid="attendance-action-result"
          role={resultMessage.tone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {resultMessage.message}
        </p>
      ) : null}

      <section className={styles.recording} aria-labelledby="attendance-recording-title">
        <div className={styles.heading}>
          <div>
            <span className={styles.kicker}>One-shot command</span>
            <h3 id="attendance-recording-title">Record accepted participant attendance</h3>
          </div>
          <p>Exact retries resolve to the same immutable observation.</p>
        </div>
        {!recordingAllowed ? (
          <p className={styles.empty} role="status">
            New attendance opens only while this event is live and within its event-time window.
          </p>
        ) : surface.targets.length === 0 ? (
          <p className={styles.empty} role="status">No accepted current-plan attendance targets are available.</p>
        ) : (
          <ul className={styles.targets}>
            {surface.targets.map((target) => {
              const existing = surface.lineages.find((lineage) =>
                lineage.personId === target.personId && lineage.programUnitId === target.programUnitId);
              return (
                <li key={`${target.personId}:${target.programUnitId}`}>
                  <div>
                    <strong>{target.personName}</strong>
                    <span>{target.programUnitName}</span>
                    <small>
                      Session window: <time dateTime={target.startsAt}>{formatTimestamp(target.startsAt, timezone)}</time>
                      {" – "}<time dateTime={target.endsAt}>{formatTimestamp(target.endsAt, timezone)}</time>
                    </small>
                  </div>
                  <form className={styles.recordForm} action={recordAction}>
                    <input type="hidden" name="personId" value={target.personId} />
                    <input type="hidden" name="programUnitId" value={target.programUnitId} />
                    <label htmlFor={`attendance-observed-at-${target.personId}-${target.programUnitId}`}>
                      Occurrence time (UTC ISO 8601)
                    </label>
                    <input
                      id={`attendance-observed-at-${target.personId}-${target.programUnitId}`}
                      name="observedAt"
                      type="text"
                      inputMode="text"
                      placeholder="2026-09-18T10:15:00.000Z"
                      maxLength={40}
                      required
                    />
                    <button type="submit" data-testid={`record-attendance-${target.personId}`}>
                      {existing ? "Retry attendance" : "Record attended"}
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles.history} aria-labelledby="attendance-history-title">
        <div className={styles.heading}>
          <div>
            <span className={styles.kicker}>Operational truth</span>
            <h3 id="attendance-history-title">Attendance history and corrections</h3>
          </div>
          <p>Corrections append meaning; they never edit or erase the original.</p>
        </div>
        {surface.lineages.length === 0 ? (
          <p className={styles.empty} role="status">No live-operations attendance has been recorded for this event.</p>
        ) : (
          <ol className={styles.lineages}>
            {surface.lineages.map((lineage) => (
              <li key={lineage.originalObservationId} data-testid={`attendance-lineage-${lineage.originalObservationId}`}>
                <div className={styles.identity}>
                  <div><strong>{lineage.personName}</strong><span>{lineage.programUnitName}</span></div>
                  <span className={styles.state} data-state={lineage.state}>{lineage.state}</span>
                </div>
                <div className={styles.truthRow} data-kind="original">
                  <div>
                    <span className={styles.meaning}>Original · attended</span>
                    <small>
                      Occurred <time dateTime={lineage.observedAt}>{formatTimestamp(lineage.observedAt, timezone)}</time>
                      {" · ingested "}
                      <time dateTime={lineage.recordedAt}>{formatTimestamp(lineage.recordedAt, timezone)}</time>
                    </small>
                  </div>
                  <span className={styles.state} data-state={lineage.state}>{lineage.state}</span>
                </div>
                {lineage.correction ? (
                  <div className={styles.truthRow} data-kind="correction">
                    <div>
                      <span className={styles.meaning}>Correction · did not attend</span>
                      <p>{lineage.correction.reason}</p>
                      <small>
                        {lineage.correction.actorDisplayName} · {lineage.correction.actorRole} ·{" "}
                        <time dateTime={lineage.correction.correctedAt}>
                          {formatTimestamp(lineage.correction.correctedAt, timezone)}
                        </time>
                        {" · ingested "}
                        <time dateTime={lineage.correction.recordedAt}>
                          {formatTimestamp(lineage.correction.recordedAt, timezone)}
                        </time>
                      </small>
                    </div>
                    <span className={styles.state} data-state="current">current</span>
                  </div>
                ) : null}
                <form className={styles.correctionForm} action={correctionAction}>
                  <input type="hidden" name="originalObservationId" value={lineage.originalObservationId} />
                  <label htmlFor={`correction-reason-${lineage.originalObservationId}`}>
                    {lineage.correction ? "Exact-retry reason" : "Correction reason"}
                  </label>
                  <textarea
                    id={`correction-reason-${lineage.originalObservationId}`}
                    name="reason"
                    minLength={8}
                    maxLength={280}
                    required
                    defaultValue={lineage.correction?.reason ?? ""}
                    aria-describedby={`correction-help-${lineage.originalObservationId}`}
                  />
                  <div>
                    <small id={`correction-help-${lineage.originalObservationId}`}>
                      Printable text, 8–280 characters. A different retry is refused.
                    </small>
                    <button type="submit" data-testid={`correct-attendance-${lineage.originalObservationId}`}>
                      {lineage.correction ? "Retry correction" : "Correct to did not attend"}
                    </button>
                  </div>
                </form>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
