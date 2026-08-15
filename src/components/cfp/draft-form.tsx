"use client";

import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
  type ReactNode,
} from "react";

import {
  saveApplicantDraftAction,
  submitApplicantDraftAction,
} from "@/app/cfp/actions";
import {
  CO_PRESENTERS_VALUE_SCHEMA,
  coPresentersEntries,
  normalizeCoPresentersFieldConfig,
  type CoPresenterEntry,
  type CoPresentersFieldConfig,
} from "@/cfp/co-presenters";
import {
  IDLE_APPLICANT_ACTION_STATE,
  applicantActionRequiresReload,
  fieldConfigInteger,
  fieldConfigText,
  fieldOptions,
  type ApplicantActionState,
  type ApplicantDraftView,
  type ApplicantFieldView,
  type ApplicantJson,
  type ApplicantSubmissionReceipt,
} from "./contracts";
import { formatApplicantDateTime } from "./call-overview";

const BOOLEAN_TYPES = new Set(["checkbox", "consent", "acknowledgement", "policyAcceptance"]);
const UNSUPPORTED_TYPES = new Set([
  "address",
  "location",
  "fileUpload",
  "matrix",
  "personReference",
  "proposalOwnerReference",
  "coSpeakerReference",
  "repeatableGroup",
]);

function shortIdentifier(value: string): string {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
}

function answerName(fieldId: string): string {
  return `answer:${fieldId}`;
}

function initialAnswerValues(fields: readonly ApplicantFieldView[]): Record<string, ApplicantJson> {
  const values: Record<string, ApplicantJson> = {};
  for (const field of fields) {
    if (Object.hasOwn(field, "value")) {
      values[field.id] = field.value ?? null;
    } else if (BOOLEAN_TYPES.has(field.type)) {
      values[field.id] = false;
    } else if (field.type === "multipleChoice" || field.type === "ranking") {
      values[field.id] = [];
    } else {
      values[field.id] = null;
    }
  }
  return values;
}

function stringValue(value: ApplicantJson | undefined): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function displayValue(value: ApplicantJson | undefined): string {
  if (value === null || value === undefined || value === "") return "Not answered";
  const coPresenters = coPresentersEntries(value);
  if (coPresenters) {
    return coPresenters.length === 0
      ? "No co-presenters or coauthors listed"
      : coPresenters.map((entry) => `${entry.fullName} — ${entry.role} (${entry.email})`).join("; ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function stringArrayValue(value: ApplicantJson | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function coPresentersFieldConfig(field: ApplicantFieldView): CoPresentersFieldConfig | null {
  return normalizeCoPresentersFieldConfig(field.config, field.type);
}

function coPresentersValue(entries: readonly CoPresenterEntry[]): ApplicantJson {
  if (entries.length === 0) return null;
  return {
    schema: CO_PRESENTERS_VALUE_SCHEMA,
    entries: entries.map((entry) => ({
      fullName: entry.fullName,
      email: entry.email,
      role: entry.role,
    })),
  };
}

function CoPresentersGroup({
  field,
  value,
  error,
  config,
  onValue,
}: {
  readonly field: ApplicantFieldView;
  readonly value: ApplicantJson | undefined;
  readonly error?: string;
  readonly config: CoPresentersFieldConfig;
  readonly onValue: (value: ApplicantJson) => void;
}) {
  const entries = coPresentersEntries(value) ? [...coPresentersEntries(value)!] : [];
  const serializedValue = entries.length === 0 ? "" : JSON.stringify(coPresentersValue(entries));

  function updateEntry(index: number, key: keyof CoPresenterEntry, nextValue: string): void {
    const next = entries.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, [key]: nextValue } : entry,
    );
    onValue(coPresentersValue(next));
  }

  function removeEntry(index: number): void {
    onValue(coPresentersValue(entries.filter((_, entryIndex) => entryIndex !== index)));
  }

  function addEntry(): void {
    if (entries.length >= config.maxEntries) return;
    onValue(coPresentersValue([
      ...entries,
      { fullName: "", email: "", role: config.roles[0] ?? "co-presenter" },
    ]));
  }

  return (
    <FieldFrame field={field} error={error}>
      {config.guidance ? <p className="cfp-guidance">{config.guidance}</p> : null}
      <input type="hidden" name={answerName(field.id)} value={serializedValue} readOnly />
      <div className="cfp-co-presenters" aria-label="Co-presenters and coauthors">
        {entries.length === 0 ? (
          <p className="cfp-guidance">No co-presenters or coauthors added yet.</p>
        ) : (
          <div className="cfp-co-presenters__list">
            {entries.map((entry, index) => (
              <div className="cfp-co-presenter" key={`${field.id}-${index}`}>
                <div className="cfp-co-presenter__fields">
                  <label>
                    Full name
                    <input
                      className="cfp-input"
                      value={entry.fullName}
                      disabled={!field.editable}
                      required={field.required && index === 0}
                      onChange={(event) => updateEntry(index, "fullName", event.target.value)}
                    />
                  </label>
                  <label>
                    Email
                    <input
                      className="cfp-input"
                      type="email"
                      value={entry.email}
                      disabled={!field.editable}
                      required={field.required && index === 0}
                      onChange={(event) => updateEntry(index, "email", event.target.value)}
                    />
                  </label>
                  <label>
                    Role
                    <select
                      className="cfp-select"
                      value={entry.role}
                      disabled={!field.editable}
                      required={field.required && index === 0}
                      onChange={(event) => updateEntry(index, "role", event.target.value)}
                    >
                      {config.roles.map((role) => <option value={role} key={role}>{role}</option>)}
                    </select>
                  </label>
                </div>
                <button
                  className="cfp-button"
                  type="button"
                  disabled={!field.editable}
                  onClick={() => removeEntry(index)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          className="cfp-button"
          type="button"
          disabled={!field.editable || entries.length >= config.maxEntries}
          onClick={addEntry}
        >
          Add co-presenter / coauthor ({entries.length}/{config.maxEntries})
        </button>
      </div>
    </FieldFrame>
  );
}

function FieldFrame({
  field,
  error,
  children,
  controlId,
}: {
  readonly field: ApplicantFieldView;
  readonly error?: string;
  readonly children: ReactNode;
  readonly controlId?: string;
}) {
  const guidance = fieldConfigText(field.config, "guidance");
  return (
    <div
      className={`cfp-question${field.editable ? "" : " cfp-question--disabled"}`}
      id={`field-${field.id}`}
      data-field-id={field.id}
      aria-disabled={field.editable ? undefined : "true"}
    >
      <div className="cfp-question__heading">
        {controlId ? <label htmlFor={controlId}>{field.label}</label> : <strong>{field.label}</strong>}
        <span>{field.required ? "Required" : "Optional"}</span>
      </div>
      {guidance ? (
        <p className="cfp-guidance" id={`guidance-${field.id}`}>
          {guidance}
        </p>
      ) : null}
      <div>{children}</div>
      {error ? (
        <p className="cfp-field-error" id={`error-${field.id}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ChoiceGroup({
  field,
  value,
  error,
  onValue,
}: {
  readonly field: ApplicantFieldView;
  readonly value: ApplicantJson | undefined;
  readonly error?: string;
  readonly onValue: (value: ApplicantJson) => void;
}) {
  const options = fieldOptions(field.config);
  const selected = new Set(stringArrayValue(value));
  const guidance = fieldConfigText(field.config, "guidance");
  const describedBy = [guidance ? `guidance-${field.id}` : null, error ? `error-${field.id}` : null]
    .filter(Boolean)
    .join(" ");

  if (options.length === 0) {
    return (
      <FieldFrame field={field} error={error}>
        <p className="cfp-field-unsupported" role="status">
          This pinned choice question has no usable options. Contact the organizer before submitting.
        </p>
      </FieldFrame>
    );
  }

  return (
    <fieldset
      className={`cfp-question${field.editable ? "" : " cfp-question--disabled"}`}
      id={`field-${field.id}`}
      disabled={!field.editable}
      aria-disabled={field.editable ? undefined : "true"}
      aria-describedby={describedBy || undefined}
    >
      <legend>
        {field.label} <span>{field.required ? "(Required)" : "(Optional)"}</span>
      </legend>
      {guidance ? (
        <p className="cfp-guidance" id={`guidance-${field.id}`}>
          {guidance}
        </p>
      ) : null}
      <div className="cfp-choice-list">
        {options.map((option) => (
          <label className="cfp-choice" key={option.value}>
            <input
              name={answerName(field.id)}
              type="checkbox"
              value={option.value}
              checked={selected.has(option.value)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(option.value);
                else next.delete(option.value);
                onValue([...next]);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {error ? (
        <p className="cfp-field-error" id={`error-${field.id}`}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function RankingGroup({
  field,
  value,
  error,
  onValue,
}: {
  readonly field: ApplicantFieldView;
  readonly value: ApplicantJson | undefined;
  readonly error?: string;
  readonly onValue: (value: ApplicantJson) => void;
}) {
  const options = fieldOptions(field.config);
  const optionByValue = new Map(options.map((option) => [option.value, option]));
  const orderedValues: string[] = [];
  const seen = new Set<string>();
  for (const candidate of stringArrayValue(value)) {
    if (optionByValue.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      orderedValues.push(candidate);
    }
  }
  for (const option of options) {
    if (!seen.has(option.value)) orderedValues.push(option.value);
  }

  const guidance = fieldConfigText(field.config, "guidance");
  const instructionId = `ranking-instructions-${field.id}`;
  const describedBy = [
    guidance ? `guidance-${field.id}` : null,
    instructionId,
    error ? `error-${field.id}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  if (options.length === 0) {
    return (
      <FieldFrame field={field} error={error}>
        <p className="cfp-field-unsupported" role="status">
          This pinned ranking question has no usable options. Contact the organizer before submitting.
        </p>
      </FieldFrame>
    );
  }

  const move = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (destination < 0 || destination >= orderedValues.length) return;
    const next = [...orderedValues];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    onValue(next);
  };

  return (
    <fieldset
      className={`cfp-question${field.editable ? "" : " cfp-question--disabled"}`}
      id={`field-${field.id}`}
      disabled={!field.editable}
      aria-disabled={field.editable ? undefined : "true"}
      aria-describedby={describedBy}
    >
      <legend>
        {field.label} <span>{field.required ? "(Required)" : "(Optional)"}</span>
      </legend>
      {guidance ? (
        <p className="cfp-guidance" id={`guidance-${field.id}`}>
          {guidance}
        </p>
      ) : null}
      <p className="cfp-guidance" id={instructionId}>
        The first option is ranked highest. Use the buttons to set the complete order.
      </p>
      <ol className="cfp-ranking-list">
        {orderedValues.map((optionValue, index) => {
          const option = optionByValue.get(optionValue)!;
          return (
            <li className="cfp-ranking-item" key={option.value}>
              <input type="hidden" name={answerName(field.id)} value={option.value} />
              <span className="cfp-ranking-item__position" aria-hidden="true">
                {index + 1}
              </span>
              <span className="cfp-ranking-item__label">{option.label}</span>
              <span className="cfp-ranking-item__actions">
                <button
                  className="cfp-ranking-button"
                  type="button"
                  disabled={!field.editable || index === 0}
                  aria-label={`Move ${option.label} up`}
                  onClick={() => move(index, -1)}
                >
                  Move up
                </button>
                <button
                  className="cfp-ranking-button"
                  type="button"
                  disabled={!field.editable || index === orderedValues.length - 1}
                  aria-label={`Move ${option.label} down`}
                  onClick={() => move(index, 1)}
                >
                  Move down
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      {error ? (
        <p className="cfp-field-error" id={`error-${field.id}`}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function ApplicantQuestion({
  field,
  value,
  error,
  onValue,
}: {
  readonly field: ApplicantFieldView;
  readonly value: ApplicantJson | undefined;
  readonly error?: string;
  readonly onValue: (value: ApplicantJson) => void;
}) {
  if (field.type === "section") {
    return (
      <section className="cfp-form-section" aria-labelledby={`section-${field.id}`}>
        <h2 id={`section-${field.id}`}>{field.label}</h2>
        {fieldConfigText(field.config, "guidance") ? (
          <p>{fieldConfigText(field.config, "guidance")}</p>
        ) : null}
      </section>
    );
  }

  if (field.type === "calculated") {
    return (
      <FieldFrame
        field={{ ...field, editable: false }}
        error={error}
        controlId={`input-${field.id}`}
      >
        <output className="cfp-calculated" id={`input-${field.id}`}>
          {stringValue(value) || fieldConfigText(field.config, "display") || "Calculated by the form"}
        </output>
      </FieldFrame>
    );
  }

  let structuredConfig: CoPresentersFieldConfig | null = null;
  let structuredConfigInvalid = false;
  try {
    structuredConfig = coPresentersFieldConfig(field);
  } catch {
    structuredConfigInvalid = true;
  }
  if (structuredConfigInvalid) {
    return (
      <FieldFrame field={{ ...field, editable: false }} error={error}>
        <p className="cfp-field-unsupported" role="status">
          This structured question is unavailable. Contact the organizer before submitting.
        </p>
      </FieldFrame>
    );
  }
  if (structuredConfig) {
    return (
      <CoPresentersGroup
        field={field}
        value={value}
        error={error}
        config={structuredConfig}
        onValue={onValue}
      />
    );
  }

  if (UNSUPPORTED_TYPES.has(field.type)) {
    return (
      <FieldFrame field={{ ...field, editable: false }} error={error}>
        <p className="cfp-field-unsupported" role="status">
          This pinned question type is not supported by the applicant MVP. Contact the organizer before submitting.
        </p>
      </FieldFrame>
    );
  }

  if (field.type === "multipleChoice") {
    return <ChoiceGroup field={field} value={value} error={error} onValue={onValue} />;
  }

  if (field.type === "ranking") {
    return <RankingGroup field={field} value={value} error={error} onValue={onValue} />;
  }

  if (field.type === "singleChoice") {
    const options = fieldOptions(field.config);
    if (options.length === 0) {
      return (
        <FieldFrame field={field} error={error}>
          <p className="cfp-field-unsupported" role="status">
            This pinned choice question has no usable options. Contact the organizer before submitting.
          </p>
        </FieldFrame>
      );
    }
    return (
      <FieldFrame field={field} error={error} controlId={`input-${field.id}`}>
        <select
          className="cfp-select"
          id={`input-${field.id}`}
          name={answerName(field.id)}
          value={stringValue(value)}
          required={field.required}
          disabled={!field.editable}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={
            [
              fieldConfigText(field.config, "guidance") ? `guidance-${field.id}` : null,
              error ? `error-${field.id}` : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          onChange={(event) => onValue(event.target.value)}
        >
          <option value="">Choose an option</option>
          {options.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FieldFrame>
    );
  }

  if (BOOLEAN_TYPES.has(field.type)) {
    const statement = field.policyStatement ?? field.label;
    const guidance = fieldConfigText(field.config, "guidance");
    const describedBy = [
      guidance ? `guidance-${field.id}` : null,
      error ? `error-${field.id}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <fieldset
        className={`cfp-question${field.editable ? "" : " cfp-question--disabled"}`}
        id={`field-${field.id}`}
        disabled={!field.editable}
        aria-disabled={field.editable ? undefined : "true"}
        aria-describedby={describedBy || undefined}
      >
        <legend>
          {field.label} <span>{field.required || field.policyRequired ? "(Required)" : "(Optional)"}</span>
        </legend>
        {guidance ? (
          <p className="cfp-guidance" id={`guidance-${field.id}`}>
            {guidance}
          </p>
        ) : null}
        <label className="cfp-choice" htmlFor={`input-${field.id}`}>
          <input
            id={`input-${field.id}`}
            name={answerName(field.id)}
            type="checkbox"
            value="true"
            checked={value === true}
            required={field.required || field.policyRequired}
            aria-invalid={error ? "true" : undefined}
            onChange={(event) => onValue(event.target.checked)}
          />
          <span>{statement}</span>
        </label>
        {error ? (
          <p className="cfp-field-error" id={`error-${field.id}`}>
            {error}
          </p>
        ) : null}
      </fieldset>
    );
  }

  const isTextarea = field.type === "longText" || field.type === "richText";
  const inputType =
    field.type === "integer" || field.type === "decimal"
      ? "number"
      : field.type === "dateTime"
        ? "datetime-local"
        : field.type === "fileLink"
          ? "url"
          : field.type === "phone"
            ? "tel"
            : field.type === "shortText"
              ? "text"
              : field.type;
  const placeholder = fieldConfigText(field.config, "placeholder");
  const maxLength = fieldConfigInteger(field.config, "maxLength", 1, 65_536) ?? 20_000;
  const common = {
    id: `input-${field.id}`,
    name: answerName(field.id),
    value: stringValue(value),
    required: field.required,
    disabled: !field.editable,
    placeholder,
    "aria-invalid": error ? ("true" as const) : undefined,
    "aria-describedby":
      [
        fieldConfigText(field.config, "guidance") ? `guidance-${field.id}` : null,
        error ? `error-${field.id}` : null,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onValue(event.target.value),
  };

  return (
    <FieldFrame field={field} error={error} controlId={`input-${field.id}`}>
      {isTextarea ? (
        <textarea className="cfp-textarea" rows={6} maxLength={maxLength} {...common} />
      ) : (
        <input
          className="cfp-input"
          type={inputType}
          maxLength={inputType === "number" ? undefined : maxLength}
          step={field.type === "integer" ? 1 : field.type === "decimal" ? "any" : undefined}
          {...common}
        />
      )}
    </FieldFrame>
  );
}

function ErrorSummary({
  state,
  fields,
  errorRef,
  reloadHref,
}: {
  readonly state: ApplicantActionState;
  readonly fields: readonly ApplicantFieldView[];
  readonly errorRef: RefObject<HTMLDivElement | null>;
  readonly reloadHref: string;
}) {
  if (state.kind !== "error" && state.kind !== "stale") return null;
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  return (
    <div className="cfp-error-summary" role="alert" tabIndex={-1} ref={errorRef}>
      <h2>{state.kind === "stale" ? "Reload required" : "Some answers need attention"}</h2>
      <p>{state.message}</p>
      {state.fieldErrors && Object.keys(state.fieldErrors).length > 0 ? (
        <ul>
          {Object.entries(state.fieldErrors).map(([fieldId, message]) => (
            <li key={fieldId}>
              <a href={`#field-${fieldId}`}>{fieldById.get(fieldId)?.label ?? "Required question"}</a>: {message}
            </li>
          ))}
        </ul>
      ) : null}
      {state.kind === "stale" ? (
        <p>
          <a className="cfp-button" href={reloadHref}>
            Reload the latest saved revision
          </a>
        </p>
      ) : null}
    </div>
  );
}

export function SubmissionReceipt({
  receipt,
  timezone,
  headingRef,
  dashboardHref,
}: {
  readonly receipt: ApplicantSubmissionReceipt;
  readonly timezone: string;
  readonly headingRef?: RefObject<HTMLHeadingElement | null>;
  readonly dashboardHref?: string;
}) {
  return (
    <section className="cfp-receipt" data-testid="applicant-submission-receipt">
      <p className="cfp-eyebrow">Immutable submission receipt</p>
      <h2 tabIndex={-1} ref={headingRef}>
        Submission received
      </h2>
      <p>Your exact latest saved revision is recorded locally. Reopen the applicant dashboard to verify this receipt after a refresh.</p>
      <dl className="cfp-receipt__details">
        <div>
          <dt>Submission</dt>
          <dd><code title={`Submission: ${receipt.submissionId}`}>{receipt.submissionId}</code></dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd><code title={`Revision: ${receipt.revisionId}`}>{receipt.revisionId}</code></dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd><time dateTime={receipt.submittedAt}>{formatApplicantDateTime(receipt.submittedAt, timezone)}</time></dd>
        </div>
      </dl>
      {dashboardHref ? (
        <p>
          <a className="cfp-button cfp-button--primary" href={dashboardHref}>
            Open applicant dashboard
          </a>
        </p>
      ) : null}
    </section>
  );
}

export function ClosedDraftReadOnly({
  draft,
  dashboardHref,
}: {
  readonly draft: ApplicantDraftView;
  readonly dashboardHref?: string;
}) {
  return (
    <section className="cfp-receipt" data-testid="applicant-closed-draft">
      <p className="cfp-eyebrow">Read-only applicant access</p>
      <h2>Applications are closed</h2>
      <p>
        This saved draft remains available as an immutable revision, but the closed call does not
        allow new saves or submissions.
      </p>
      <dl className="cfp-receipt__details">
        <div>
          <dt>Current revision</dt>
          <dd>
            <code title={`Revision: ${draft.currentRevisionId}`}>{draft.currentRevisionId}</code>
          </dd>
        </div>
        {draft.fields.map((field) => (
          <div key={field.id}>
            <dt>{field.label}</dt>
            <dd>{displayValue(field.value)}</dd>
          </div>
        ))}
      </dl>
      {dashboardHref ? (
        <p>
          <a className="cfp-button cfp-button--primary" href={dashboardHref}>
            Open applicant dashboard
          </a>
        </p>
      ) : null}
    </section>
  );
}

export function TerminalSubmission({
  draft,
  dashboardHref,
}: {
  readonly draft: ApplicantDraftView;
  readonly dashboardHref?: string;
}) {
  const label =
    draft.submissionState === "SUBMITTED"
      ? "Submission received"
      : draft.submissionState === "WITHDRAWN"
        ? "Submission withdrawn"
        : "Submission unavailable";
  return (
    <section className="cfp-receipt" data-testid="applicant-terminal-submission">
      <p className="cfp-eyebrow">Terminal applicant state</p>
      <h2>{label}</h2>
      <p>
        This application is read-only in the draft surface. The applicant dashboard reports whether
        the call is open and why a submitted edit can or cannot be created.
      </p>
      <dl className="cfp-receipt__details">
        <div>
          <dt>Status</dt>
          <dd>{draft.submissionState}</dd>
        </div>
        <div>
          <dt>Current revision</dt>
          <dd>
            <code title={`Revision: ${draft.currentRevisionId}`}>{draft.currentRevisionId}</code>
          </dd>
        </div>
      </dl>
      {dashboardHref ? (
        <p>
          <a className="cfp-button cfp-button--primary" href={dashboardHref}>
            Open applicant dashboard
          </a>
        </p>
      ) : null}
    </section>
  );
}

export function ApplicantDraftForm({
  workspace,
  callSlug,
  draft,
  saved,
}: {
  readonly workspace: string;
  readonly callSlug: string;
  readonly draft: ApplicantDraftView;
  readonly saved: boolean;
}) {
  const initialValues = useMemo(() => initialAnswerValues(draft.fields), [draft.fields]);
  const [values, setValues] = useState<Record<string, ApplicantJson>>(initialValues);
  const [dirty, setDirty] = useState(false);
  const saveAction = saveApplicantDraftAction.bind(
    null,
    workspace,
    callSlug,
    draft.currentRevisionId,
  );
  const submitAction = submitApplicantDraftAction.bind(
    null,
    workspace,
    callSlug,
    draft.currentRevisionId,
  );
  const [saveState, saveFormAction, savePending] = useActionState(
    saveAction,
    IDLE_APPLICANT_ACTION_STATE,
  );
  const [submitState, submitFormAction, submitPending] = useActionState(
    submitAction,
    IDLE_APPLICANT_ACTION_STATE,
  );
  const activeState =
    saveState.kind === "stale"
      ? saveState
      : submitState.kind === "stale"
        ? submitState
        : submitState.kind !== "idle"
          ? submitState
          : saveState;
  const errorRef = useRef<HTMLDivElement>(null);
  const receiptHeadingRef = useRef<HTMLHeadingElement>(null);
  const baseHref = `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}/draft`;
  const dashboardHref = `/cfp/${encodeURIComponent(workspace)}/${encodeURIComponent(callSlug)}/dashboard`;

  useEffect(() => {
    if (activeState.kind === "error" || activeState.kind === "stale") errorRef.current?.focus();
  }, [activeState]);
  useEffect(() => {
    if (submitState.kind === "submitted") receiptHeadingRef.current?.focus();
  }, [submitState]);

  if (submitState.kind === "submitted") {
    return (
      <SubmissionReceipt
        receipt={submitState.receipt}
        timezone={draft.call.timezone}
        headingRef={receiptHeadingRef}
        dashboardHref={dashboardHref}
      />
    );
  }

  const submittedAmendment =
    draft.submissionState === "SUBMITTED" && draft.call.availability === "open";

  if (draft.submissionState !== "DRAFT" && !submittedAmendment) {
    return <TerminalSubmission draft={draft} dashboardHref={dashboardHref} />;
  }

  if (draft.call.availability === "closed") {
    return <ClosedDraftReadOnly draft={draft} dashboardHref={dashboardHref} />;
  }

  const fieldErrors = activeState.kind === "error" ? activeState.fieldErrors : undefined;
  const reconciliationRequired = applicantActionRequiresReload(activeState);
  return (
    <form
      className="cfp-form cfp-application-form"
      id="application-form"
      action={saveFormAction}
      onChange={() => setDirty(true)}
      noValidate
    >
      <div className="cfp-form__header">
        <div>
          <p className="cfp-eyebrow">
            {submittedAmendment ? "Immutable submitted proposal" : "Pinned conditional form"}
          </p>
          <h2>{submittedAmendment ? "Amend your submitted proposal" : "Your application"}</h2>
        </div>
        <p className="cfp-revision-label">
          Saved revision <code title={`Revision: ${draft.currentRevisionId}`}>{shortIdentifier(draft.currentRevisionId)}</code>
        </p>
      </div>

      {saved ? (
        <div className="cfp-form-status" role="status">
          <p>
            {submittedAmendment
              ? "Amendment saved as a new immutable revision; the submitted state and original submission receipt remain unchanged."
              : "Draft saved. Conditional questions and requirements are up to date."}
          </p>
        </div>
      ) : null}

      <ErrorSummary state={activeState} fields={draft.fields} errorRef={errorRef} reloadHref={baseHref} />

      {draft.hiddenAnswerCount > 0 ? (
        <div className="cfp-hidden-answer-notice" role="status">
          <strong>
            {draft.hiddenAnswerCount} {draft.hiddenAnswerCount === 1 ? "answer is" : "answers are"} currently hidden.
          </strong>{" "}
          Hidden history is retained, but excluded from effective submission data while hidden.
        </div>
      ) : null}

      <div className="cfp-question-stack">
        {draft.fields.map((field) => (
          <ApplicantQuestion
            key={field.id}
            field={field}
            value={values[field.id]}
            error={fieldErrors?.[field.id]}
            onValue={(value) => {
              setValues((current) => ({ ...current, [field.id]: value }));
              setDirty(true);
            }}
          />
        ))}
      </div>

      <section className="cfp-submit-panel" aria-labelledby="cfp-submit-title">
        <h2 id="cfp-submit-title">{submittedAmendment ? "Save a new revision" : "Save, then submit"}</h2>
        <p id="cfp-submit-guidance">
          {submittedAmendment
            ? "Saving creates a new immutable revision and preserves the submitted state, submission identity, and original submitted timestamp."
            : "Save first to run the accepted server evaluator. Submission creates a fresh immutable revision from this exact saved version and closes editing in the applicant UI."}
        </p>
        <p className="cfp-submit-panel__status" aria-live="polite">
          {dirty ? "Unsaved changes — save before submitting." : "All displayed changes are saved."}
        </p>
        <div className="cfp-button-row">
          <button
            className="cfp-button"
            type="submit"
            formNoValidate
            disabled={reconciliationRequired || savePending || submitPending}
          >
            {savePending ? "Saving…" : "Save draft"}
          </button>
          {!submittedAmendment ? (
            <button
              className="cfp-button cfp-button--primary"
              type="submit"
              formAction={submitFormAction}
              disabled={reconciliationRequired || dirty || savePending || submitPending}
              aria-describedby="cfp-submit-guidance"
            >
              {submitPending ? "Submitting…" : dirty ? "Save changes before submitting" : "Submit saved revision"}
            </button>
          ) : null}
        </div>
        <p className="cfp-muted">
          Required acknowledgement receipt: {draft.hasConsentReceipt ? "saved" : "not complete"}.
        </p>
      </section>
    </form>
  );
}
