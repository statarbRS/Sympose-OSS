"use client";

import Link from "next/link";
import { useActionState, useMemo, useState, type FormEvent, type ReactNode } from "react";

import {
  decideOrganizerCfpSubmissionAction,
  saveOrganizerCfpAction,
  type OrganizerCfpActionState,
  type OrganizerCfpDecisionActionState,
} from "@/app/cfp/organizer-actions";
import type {
  OrganizerCfpCallProjection,
  OrganizerCfpOverview as OrganizerCfpOverviewModel,
} from "@/server/services/cfp/organizer";
import type {
  CfpDecisionCommunicationReceipt,
  CfpSubmissionDecision,
} from "@/server/services/cfp/decisions";
import { FORM_FIELD_TYPES, type FormFieldType } from "@/cfp/form-field-contract";
import type { FormFieldDefinition } from "@/server/services/cfp/form-types";
import { Fingerprint } from "@/components/truth";
import {
  CO_PRESENTERS_FIELD_CONFIG_SCHEMA,
  CO_PRESENTERS_VALUE_SCHEMA,
  DEFAULT_CO_PRESENTERS_ROLES,
  coPresentersEntries,
} from "@/cfp/co-presenters";

import styles from "./organizer-cfp.module.css";

const FIELD_TYPES: readonly FormFieldType[] = FORM_FIELD_TYPES;
const IDLE_ORGANIZER_CFP_ACTION: OrganizerCfpActionState = {
  kind: "idle",
  message: "",
};
const IDLE_ORGANIZER_CFP_DECISION_ACTION: OrganizerCfpDecisionActionState = {
  kind: "idle",
  message: "",
};

type FieldDraft = {
  id: string;
  type: FormFieldType;
  label: string;
  required: boolean;
  defaultVisibility: "visible" | "hidden";
  configText: string;
};

function toFieldDraft(field: FormFieldDefinition): FieldDraft {
  return {
    id: field.id,
    type: field.type,
    label: field.label,
    required: field.required,
    defaultVisibility: field.defaultVisibility,
    configText: JSON.stringify(field.config ?? {}, null, 2),
  };
}

function defaultFields(): FieldDraft[] {
  return [
    toFieldDraft({
      id: "title",
      type: "shortText",
      label: "Proposal title",
      required: true,
      defaultVisibility: "visible",
    }),
    toFieldDraft({
      id: "abstract",
      type: "longText",
      label: "Proposal abstract",
      required: true,
      defaultVisibility: "visible",
      config: { maxLength: 4000 },
    }),
    toFieldDraft({
      id: "consent",
      type: "consent",
      label: "I accept the call privacy and publication terms.",
      required: true,
      defaultVisibility: "visible",
    }),
  ];
}

function policyForEditor(projection?: OrganizerCfpCallProjection): string {
  return JSON.stringify(
    projection
      ? { disclosure: projection.policy.disclosure, choices: projection.policy.choices }
      : {
          disclosure: {
            privacy: "Only the event team can administer this application.",
            retention: "Application records are retained according to the event policy.",
            aiProcessing: "No AI processing is used in this call.",
            communication: "The organizer may email about this application.",
            consent: "Required acknowledgements are recorded with the submission revision.",
            publication: "Accepted proposal details may be published only under organizer policy.",
          },
          choices: [
            {
              fieldId: "consent",
              statement: "I accept the call privacy and publication terms.",
              required: true,
            },
          ],
        },
    null,
    2,
  );
}

function updateAt<T extends keyof FieldDraft>(
  fields: readonly FieldDraft[],
  index: number,
  key: T,
  value: FieldDraft[T],
): FieldDraft[] {
  return fields.map((field, candidateIndex) =>
    candidateIndex === index ? { ...field, [key]: value } : field,
  );
}

function serializeFields(fields: readonly FieldDraft[]):
  | { readonly ok: true; readonly fields: readonly FormFieldDefinition[] }
  | { readonly ok: false; readonly message: string } {
  try {
    const seen = new Set<string>();
    const serialized = fields.map((field) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(field.id) || seen.has(field.id)) {
        throw new Error("Question IDs must be unique and use letters, numbers, ., _, :, or -.");
      }
      seen.add(field.id);
      const config = JSON.parse(field.configText) as unknown;
      if (config === null || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`Configuration for ${field.id} must be a JSON object.`);
      }
      return {
        id: field.id,
        type: field.type,
        label: field.label,
        required: field.required,
        defaultVisibility: field.defaultVisibility,
        ...(Object.keys(config).length > 0
          ? { config: config as FormFieldDefinition["config"] }
          : {}),
      } as FormFieldDefinition;
    });
    return { ok: true, fields: serialized };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Question configuration is invalid.",
    };
  }
}

function ActionMessage({ state }: { readonly state: OrganizerCfpActionState }) {
  if (state.kind !== "error") return null;
  return (
    <div className={styles.error} role="alert">
      <strong>{state.code}</strong>
      <p>{state.message}</p>
    </div>
  );
}

function formatAnswerValue(value: unknown): string {
  if (value === null) return "Not answered";
  const coPresenters = coPresentersEntries(value);
  if (coPresenters) {
    return coPresenters.length === 0
      ? "No co-presenters or coauthors listed"
      : coPresenters
          .map((entry) => `${entry.fullName} — ${entry.role} (${entry.email})`)
          .join("; ");
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "Not answered";
  } catch {
    return "Unreadable value";
  }
}

function answerByLabel(
  submission: OrganizerCfpCallProjection["submissions"][number],
  ids: readonly string[],
  labels: readonly string[],
): string | null {
  const exact = new Map(submission.answers.map((answer) => [answer.fieldId, answer.value]));
  for (const id of ids) {
    const value = exact.get(id);
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  for (const answer of submission.answers) {
    if (!labels.some((label) => answer.label.toLowerCase().includes(label))) continue;
    if (typeof answer.value === "string" && answer.value.trim().length > 0) return answer.value;
  }
  return null;
}

function DecisionActionMessage({ state }: { readonly state: OrganizerCfpDecisionActionState }) {
  if (state.kind === "idle") return null;
  if (state.kind === "error") {
    return <p className={styles.error} role="alert"><strong>{state.code}</strong> · {state.message}</p>;
  }
  return (
    <div className={styles.receipt} role="status">
      <strong>{state.receipt.decision === "ACCEPTED" ? "Accepted" : "Rejected"} decision recorded.</strong>
      <span>Decision event <code>{state.receipt.decisionEventId}</code> · {state.receipt.replayed ? "replayed safely" : "new immutable event"}.</span>
      <DecisionCommunicationReceiptView receipt={state.receipt.communication} />
    </div>
  );
}

function DecisionCommunicationReceiptView({
  receipt,
}: {
  readonly receipt: CfpDecisionCommunicationReceipt | null;
}) {
  if (!receipt) {
    return <span>Communication evidence is unavailable; no delivery claim is shown.</span>;
  }
  return (
    <div className={styles.stack} data-testid="cfp-decision-communication-receipt">
      <strong>Queued in local inbox simulation · PENDING</strong>
      <span>Recipient: {receipt.recipientDisplayName} &lt;{receipt.recipientEmail}&gt;</span>
      <span>Template: <code>{receipt.templateKey}</code></span>
      <span>Subject: {receipt.renderedSubject}</span>
      <span style={{ whiteSpace: "pre-wrap" }}>Body: {receipt.renderedBody}</span>
      <span>Local inbox simulation · simulated {String(receipt.simulated)} · providerMutation {String(receipt.providerMutation)}.</span>
      <span>Durable outbox receipt <code>{receipt.receiptId}</code> · payload <code>{receipt.payloadFingerprint}</code>.</span>
    </div>
  );
}

function OrganizerSubmissionDecisionControls({
  workspace,
  eventId,
  callId,
  submission,
}: {
  readonly workspace: string;
  readonly eventId: string;
  readonly callId: string;
  readonly submission: OrganizerCfpCallProjection["submissions"][number];
}) {
  const expectedRevisionId = submission.currentRevisionId;
  const acceptAction = expectedRevisionId
    ? decideOrganizerCfpSubmissionAction.bind(
        null,
        workspace,
        eventId,
        callId,
        submission.submissionId,
        expectedRevisionId,
        "ACCEPTED" as CfpSubmissionDecision,
      )
    : null;
  const rejectAction = expectedRevisionId
    ? decideOrganizerCfpSubmissionAction.bind(
        null,
        workspace,
        eventId,
        callId,
        submission.submissionId,
        expectedRevisionId,
        "REJECTED" as CfpSubmissionDecision,
      )
    : null;
  const [acceptState, acceptFormAction, accepting] = useActionState(
    acceptAction ?? (async () => IDLE_ORGANIZER_CFP_DECISION_ACTION),
    IDLE_ORGANIZER_CFP_DECISION_ACTION,
  );
  const [rejectState, rejectFormAction, rejecting] = useActionState(
    rejectAction ?? (async () => IDLE_ORGANIZER_CFP_DECISION_ACTION),
    IDLE_ORGANIZER_CFP_DECISION_ACTION,
  );

  if (submission.state !== "SUBMITTED" || expectedRevisionId === null) {
    return <span className={styles.muted}>Decision available after submission.</span>;
  }
  if (submission.decision) {
    return (
      <div className={styles.decisionBlock}>
        <strong>{submission.decision.decision === "ACCEPTED" ? "Accepted" : "Rejected"}</strong>
        <small>Recorded for revision v{submission.revisionNumber}.</small>
        <DecisionCommunicationReceiptView receipt={submission.decision.communication} />
        <DecisionActionMessage state={acceptState} />
        <DecisionActionMessage state={rejectState} />
      </div>
    );
  }
  return (
    <div className={styles.decisionBlock}>
      <strong>Organizer decision</strong>
      <small>Reviewer evidence may inform this decision but does not make it.</small>
      <div className={styles.decisionActions}>
        <form action={acceptFormAction}>
          <button type="submit" disabled={accepting || rejecting}>{accepting ? "Accepting…" : "Accept"}</button>
        </form>
        <form action={rejectFormAction}>
          <button type="submit" disabled={accepting || rejecting}>{rejecting ? "Rejecting…" : "Reject"}</button>
        </form>
      </div>
      <DecisionActionMessage state={acceptState} />
      <DecisionActionMessage state={rejectState} />
    </div>
  );
}

function OrganizerSubmissionRoundTrip({
  workspace,
  eventId,
  callId,
  submissions,
}: {
  readonly workspace: string;
  readonly eventId: string;
  readonly callId: string;
  readonly submissions: OrganizerCfpCallProjection["submissions"];
}) {
  return (
    <section className={styles.stack} data-testid="organizer-cfp-submissions" aria-labelledby="cfp-submissions-title">
      <div>
        <p className={styles.eyebrow}>Applicant round trip</p>
        <h3 id="cfp-submissions-title">Submission evidence</h3>
        <p className={styles.help}>
          This organizer view reads each tenant-scoped submission pointer and its immutable current
          revision. Authorized organizers see the exact snapshotted recipient email in a recorded
          decision communication receipt; contact details are otherwise omitted from this table.
        </p>
      </div>
      {submissions.length === 0 ? (
        <div className={styles.empty}><p>No applicant submissions yet.</p></div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Applicant / proposal</th>
                <th scope="col">Status</th>
                <th scope="col">Revision</th>
                <th scope="col">Consent</th>
                <th scope="col">Lineage</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((submission) => (
                <tr key={submission.submissionId}>
                  <td>
                    <strong>{answerByLabel(submission, ["title", "proposalTitle"], ["title"]) ?? "Untitled proposal"}</strong>
                    <small>{submission.applicant.displayName}{submission.applicant.organization ? ` · ${submission.applicant.organization}` : ""}</small>
                    <details className={styles.detail}>
                      <summary>View submitted values</summary>
                      <dl>
                        {submission.answers.length === 0 ? <p>No current revision values.</p> : submission.answers.map((answer) => (
                          <div key={answer.fieldId}>
                            <dt>{answer.label}</dt>
                            <dd>{formatAnswerValue(answer.value)}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                    <small>Submission <code>{submission.submissionId}</code></small>
                  </td>
                  <td>{submission.state}</td>
                  <td>
                    {submission.currentRevisionId ? (
                      <>
                        <code>{submission.currentRevisionId}</code>
                        <small> · v{submission.revisionNumber}</small>
                      </>
                    ) : "Not saved"}
                  </td>
                  <td>{submission.hasConsentReceipt ? "Recorded" : "Not recorded"}</td>
                  <td>{submission.lineageId ? <code>{submission.lineageId}</code> : "Unassigned"}</td>
                  <td>
                    <OrganizerSubmissionDecisionControls
                      workspace={workspace}
                      eventId={eventId}
                      callId={callId}
                      submission={submission}
                    />
                    {submission.decision?.handoff ? (
                      <div className={styles.handoff}>
                        <strong>Session handoff ready</strong>
                        <small>{submission.decision.handoff.title}{submission.decision.handoff.format ? ` · ${submission.decision.handoff.format}` : ""}</small>
                        <small>
                          Linked program session <code>{submission.decision.handoff.linkedSession.programUnitId}</code> · {submission.decision.handoff.linkedSession.status}
                        </small>
                        <small>{submission.decision.handoff.note}</small>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function OrganizerCfpFrame({
  workspace,
  event,
  children,
}: {
  readonly workspace: string;
  readonly event: OrganizerCfpOverviewModel["event"];
  readonly children: ReactNode;
}) {
  const eventBase = `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(event.id)}`;
  return (
    <article className={styles.surface}>
      <a className={styles.skipLink} href="#cfp-organizer-main">Skip to CFP organizer surface</a>
      <nav className={styles.nav} aria-label="CFP organizer">
        <Link href={`${eventBase}/overview`}>Event overview</Link>
        <Link aria-current="page" href={`${eventBase}/cfp`}>Call for proposals</Link>
        <Link href={`${eventBase}/review`}>Review room</Link>
      </nav>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Organizer · {event.name}</p>
          <h1>Call for proposals</h1>
        </div>
        <p>Build, validate, and publish the applicant-facing call using immutable form and rule versions.</p>
      </header>
      <main id="cfp-organizer-main">{children}</main>
    </article>
  );
}

export function OrganizerCfpOverview({
  workspace,
  event,
  calls,
}: {
  readonly workspace: string;
  readonly event: OrganizerCfpOverviewModel["event"];
  readonly calls: OrganizerCfpOverviewModel["calls"];
}) {
  const base = `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(event.id)}/cfp`;
  return (
    <section className={styles.stack} aria-labelledby="cfp-calls-title">
      <div className={styles.toolbar}>
        <div>
          <p className={styles.eyebrow}>Form versions and lifecycle</p>
          <h2 id="cfp-calls-title">Calls in this event</h2>
        </div>
        <Link className={styles.primaryButton} href={`${base}/new`}>Create a call</Link>
      </div>
      {calls.length === 0 ? (
        <div className={styles.empty}>
          <h3>No calls yet</h3>
          <p>Create the first call to define applicant questions, conditional rules, consent, and the public window.</p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Workspace-scoped CFP calls</caption>
            <thead><tr><th scope="col">Call</th><th scope="col">State</th><th scope="col">Form</th><th scope="col">Submissions</th><th scope="col"><span className={styles.visuallyHidden}>Action</span></th></tr></thead>
            <tbody>{calls.map((call) => (
              <tr key={call.callId}>
                <td><Link href={`${base}/${encodeURIComponent(call.callId)}`}>{call.name}</Link><small>{call.slug}</small></td>
                <td><span className={styles.status}>{call.state}</span></td>
                <td>
                  <div className={styles.formEvidence}>
                    <strong>Form v{call.formVersionNumber}</strong>
                    <span>Immutable form version</span>
                    <Fingerprint value={call.formFingerprint} label="Form version fingerprint" />
                  </div>
                </td>
                <td>{call.submissionCounts.submitted} submitted · {call.submissionCounts.draft} drafts</td>
                <td>
                  <div className={styles.rowActions}>
                    <Link href={`${base}/${encodeURIComponent(call.callId)}`}>Edit</Link>
                    {call.state !== "DRAFT" && call.state !== "ARCHIVED" && call.state !== "CANCELLED" ? (
                      <Link href={`/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(call.slug)}`}>
                        Open applicant portal
                      </Link>
                    ) : (
                      <span>Publish to open portal</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className={styles.panelGrid}>
        <section className={styles.panel} aria-labelledby="cfp-version-lineage-title">
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.eyebrow}>Version lineage</p>
              <h3 id="cfp-version-lineage-title">Immutable call evidence</h3>
            </div>
            <span className={styles.panelMeta}>{calls.length} {calls.length === 1 ? "call" : "calls"}</span>
          </div>
          {calls.length === 0 ? (
            <p className={styles.help}>Create a call to establish its first immutable form, rule, and policy versions.</p>
          ) : (
            <div className={styles.lineageList}>
              {calls.map((call) => (
                <article className={styles.lineageItem} key={call.callId}>
                  <div className={styles.lineageItemHeader}>
                    <Link href={`${base}/${encodeURIComponent(call.callId)}`}>{call.name}</Link>
                    <span className={styles.status}>{call.state}</span>
                  </div>
                  <dl className={styles.lineageDetails}>
                    <div>
                      <dt>Form version</dt>
                      <dd>v{call.formVersionNumber} · <code>{call.formVersionId}</code></dd>
                    </div>
                    <div>
                      <dt>Form fingerprint</dt>
                      <dd><Fingerprint value={call.formFingerprint} label="Form version fingerprint" /></dd>
                    </div>
                    <div>
                      <dt>Rule version</dt>
                      <dd><code>{call.ruleVersionId}</code></dd>
                    </div>
                    <div>
                      <dt>Policy fingerprint</dt>
                      <dd><Fingerprint value={call.policyFingerprint} label="Policy fingerprint" /></dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          )}
        </section>
        <section className={styles.panel} aria-labelledby="cfp-next-steps-title">
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.eyebrow}>Next steps</p>
              <h3 id="cfp-next-steps-title">Move the call forward</h3>
            </div>
          </div>
          <ol className={styles.nextSteps}>
            <li>
              <div>
                <strong>Review the exact form</strong>
                <span>{calls.length === 0 ? "Create a call to establish the first version." : "Open a call to review its current immutable form, rules, and policy evidence."}</span>
              </div>
            </li>
            <li>
              <div>
                <strong>Save the next draft</strong>
                <span>Changes append a new immutable version while preserving prior history.</span>
              </div>
            </li>
            <li>
              <div>
                <strong>Publish when ready</strong>
                <span>Use the call editor to move through its lifecycle and open the applicant portal when available.</span>
              </div>
            </li>
          </ol>
        </section>
      </div>
    </section>
  );
}

export function OrganizerCfpBuilder({
  workspace,
  event,
  callId,
  projection,
}: {
  readonly workspace: string;
  readonly event: OrganizerCfpOverviewModel["event"];
  readonly callId: string | null;
  readonly projection?: OrganizerCfpCallProjection;
}) {
  const summary = projection?.summary;
  const action = saveOrganizerCfpAction.bind(
    null,
    workspace,
    event.id,
    callId,
    summary?.updatedAt ?? null,
  );
  const [state, formAction, pending] = useActionState(action, IDLE_ORGANIZER_CFP_ACTION);
  const [fields, setFields] = useState<FieldDraft[]>(() =>
    projection?.fields.map(toFieldDraft) ?? defaultFields(),
  );
  const [editorError, setEditorError] = useState<string | null>(null);
  const rulesText = useMemo(
    () => JSON.stringify(projection ? { schema: projection.rules.schema, rules: projection.rules.rules } : { schema: "cfp-form-rules/v1", rules: [] }, null, 2),
    [projection],
  );
  const policyText = useMemo(() => policyForEditor(projection), [projection]);
  const serialized = serializeFields(fields);
  const base = `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(event.id)}/cfp`;
  const formLocked = summary?.state === "CLOSED" || summary?.state === "ARCHIVED" || summary?.state === "CANCELLED";
  const portalHref = summary && summary.state !== "DRAFT" && summary.state !== "ARCHIVED" && summary.state !== "CANCELLED"
    ? `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(summary.slug)}`
    : null;

  function validateBeforeSubmit(eventValue: FormEvent<HTMLFormElement>): void {
    const result = serializeFields(fields);
    if (!result.ok) {
      eventValue.preventDefault();
      setEditorError(result.message);
    } else {
      setEditorError(null);
    }
  }

  return (
    <section className={styles.stack} aria-labelledby="cfp-builder-title">
      <div className={styles.toolbar}>
        <div>
          <p className={styles.eyebrow}>{summary ? `Editing ${summary.slug}` : "New applicant call"}</p>
          <h2 id="cfp-builder-title">{summary ? summary.name : "Build the call"}</h2>
        </div>
        <div className={styles.toolbarActions}>
          <Link href={base}>Back to calls</Link>
          <Link href={`/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(event.id)}/review`}>Review room</Link>
          {portalHref ? <Link href={portalHref}>Open applicant portal</Link> : <span>Publish to open applicant portal</span>}
        </div>
      </div>
      {formLocked ? <div className={styles.locked} role="status"><strong>This call is locked.</strong> Closed, archived, and cancelled calls retain their history but cannot be edited here.</div> : null}
      {projection && callId ? (
        <OrganizerSubmissionRoundTrip
          workspace={workspace}
          eventId={event.id}
          callId={callId}
          submissions={projection.submissions}
        />
      ) : null}
      <ActionMessage state={state} />
      {editorError ? <div className={styles.error} role="alert"><strong>Builder validation</strong><p>{editorError}</p></div> : null}
      <form className={styles.form} action={formAction} onSubmit={validateBeforeSubmit}>
        <fieldset disabled={formLocked || pending}>
          <legend>Call identity and publication window</legend>
          <div className={styles.grid}>
            <label>Name<input name="name" defaultValue={summary?.name ?? "Community call"} required maxLength={256} /></label>
            <label>Slug<input name="slug" defaultValue={summary?.slug ?? "community-call"} pattern="[A-Za-z0-9_-]{1,128}" required /></label>
            <label>Access mode<select name="accessMode" defaultValue={summary?.accessMode ?? "PUBLIC"}><option value="PUBLIC">Public</option><option value="PUBLIC_AND_INVITED">Public and invited</option><option value="INVITED">Invited only</option></select></label>
            <label>Lifecycle<select name="state" defaultValue={summary?.state ?? "DRAFT"}><option value="DRAFT">Draft</option><option value="SCHEDULED">Scheduled</option><option value="OPEN">Open</option><option value="PAUSED">Paused</option><option value="CLOSED">Closed</option></select></label>
            <label>Timezone<input name="timezone" defaultValue={summary?.timezone ?? event.timezone} required /></label>
            <label>Opens at (UTC)<input name="opensAt" type="datetime-local" defaultValue={summary?.opensAt?.slice(0, 16) ?? ""} /></label>
            <label>Closes at (UTC)<input name="closesAt" type="datetime-local" defaultValue={summary?.closesAt?.slice(0, 16) ?? ""} /></label>
          </div>
        </fieldset>

        <fieldset disabled={formLocked || pending}>
          <legend>Questions and conditional rules</legend>
          <p className={styles.help}>Each save creates an immutable form/rule version. Conditional rules are validated server-side before a version is sealed.</p>
          <div className={styles.fieldList}>
            {fields.map((field, index) => (
              <article className={styles.fieldCard} key={`${field.id}-${index}`}>
                <div className={styles.fieldCardHeader}><strong>Question {index + 1}</strong><button type="button" onClick={() => setFields(fields.filter((_, candidateIndex) => candidateIndex !== index))}>Remove</button></div>
                <div className={styles.grid}>
                  <label>Field ID<input value={field.id} onChange={(eventValue) => setFields(updateAt(fields, index, "id", eventValue.target.value))} /></label>
                  <label>Type<select value={field.type} onChange={(eventValue) => setFields(updateAt(fields, index, "type", eventValue.target.value as FormFieldType))}>{FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
                  <label className={styles.wide}>Label<input value={field.label} onChange={(eventValue) => setFields(updateAt(fields, index, "label", eventValue.target.value))} /></label>
                  <label>Visibility<select value={field.defaultVisibility} onChange={(eventValue) => setFields(updateAt(fields, index, "defaultVisibility", eventValue.target.value as FieldDraft["defaultVisibility"]))}><option value="visible">Visible</option><option value="hidden">Conditional/hidden</option></select></label>
                  <label className={styles.checkbox}><input type="checkbox" checked={field.required} onChange={(eventValue) => setFields(updateAt(fields, index, "required", eventValue.target.checked))} /> Required</label>
                  <label className={styles.wide}>Config JSON<textarea value={field.configText} onChange={(eventValue) => setFields(updateAt(fields, index, "configText", eventValue.target.value))} rows={2} /></label>
                </div>
              </article>
            ))}
          </div>
          <div className={styles.actions}>
            <button type="button" onClick={() => setFields([...fields, { id: `question${fields.length + 1}`, type: "shortText", label: "New question", required: false, defaultVisibility: "visible", configText: "{}" }])}>Add question</button>
            <button
              type="button"
              onClick={() => setFields([
                ...fields,
                {
                  id: `coPresenters${fields.length + 1}`,
                  type: "longText",
                  label: "Co-presenters / coauthors",
                  required: false,
                  defaultVisibility: "visible",
                  configText: JSON.stringify({
                    schema: CO_PRESENTERS_FIELD_CONFIG_SCHEMA,
                    maxEntries: 4,
                    roles: DEFAULT_CO_PRESENTERS_ROLES,
                    guidance: "Add each co-presenter or coauthor with their role and contact email.",
                  }, null, 2),
                },
              ])}
            >
              Add co-presenter / coauthor field
            </button>
          </div>
          <p className={styles.help}>
            The co-presenter field uses {CO_PRESENTERS_FIELD_CONFIG_SCHEMA} and stores a bounded
            {" "}{CO_PRESENTERS_VALUE_SCHEMA} value in each immutable revision.
          </p>
          <label>Conditional rules JSON<textarea name="rules" defaultValue={rulesText} rows={8} /></label>
          <input type="hidden" name="fields" value={serialized.ok ? JSON.stringify(serialized.fields) : "[]"} readOnly />
        </fieldset>

        <fieldset disabled={formLocked || pending}>
          <legend>Disclosure and consent policy</legend>
          <p className={styles.help}>Keep applicant-facing processing claims explicit. This local slice makes no AI or provider claim beyond the text saved here.</p>
          <label>Policy JSON<textarea name="policy" defaultValue={policyText} rows={12} /></label>
        </fieldset>

        <div className={styles.actions}>
          <button type="submit" name="publish" value="false" disabled={formLocked || pending}>{pending ? "Saving…" : "Save draft"}</button>
          <button className={styles.primaryButton} type="submit" name="publish" value="true" disabled={formLocked || pending}>Publish open call</button>
        </div>
      </form>
    </section>
  );
}
