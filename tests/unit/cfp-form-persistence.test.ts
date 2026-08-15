import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprintOf } from "../../src/server/canonical";
import { closeDb, openDb, withTransaction, type Db } from "../../src/server/db";
import { DDL } from "../../src/server/schema";
import {
  CFP_CALL_POLICY_SCHEMA,
  CFP_CONSENT_RECEIPT_SCHEMA,
  CFP_FINGERPRINT_ALGORITHM,
  CFP_SUBMISSION_REVISION_SCHEMA,
  FormDocumentPersistenceError,
  createCall,
  createDraftSubmission,
  createFormDefinition,
  readCurrentSubmissionDocument,
  readCurrentSubmissionRevision,
  readFormVersionDocument,
  readRuleVersion,
  readSubmissionRevision,
  readSubmissionRevisionDocument,
  saveDraftRevision,
  sealFormVersion,
  advanceCallFormVersion,
  createCfpPersistence,
  readCall,
  updateCallPolicy,
  type OrganizerContext,
  type CreateDraftSubmissionInput,
  type SaveDraftRevisionInput,
} from "../../src/server/services/cfp/form-documents";
import { FORM_DOCUMENT_SCHEMA, normalizeFormDocument } from "../../src/server/services/cfp/form-types";
import { FORM_RULES_SCHEMA } from "../../src/server/services/cfp/form-evaluator";
import { sanitizeFormData } from "../../src/server/services/cfp/form-safety";
import {
  runPersistentRaceActor,
  startPersistentRaceActors,
  stopPersistentRaceActors,
} from "./helpers/persistent-race-actor";

const LITERAL_POLICY_LIMIT = 512 * 1024;
const LITERAL_RECEIPT_LIMIT = 64 * 1024;
const LITERAL_OUTER_LIMIT = 4 * 1024 * 1024;

const SAVE_DRAFT_INPUT_KEYS: Record<keyof SaveDraftRevisionInput, true> = {
  submissionId: true,
  historicalAnswers: true,
  expectedCurrentRevisionId: true,
};
const CREATE_DRAFT_INPUT_KEYS: Record<keyof CreateDraftSubmissionInput, true> = {
  callId: true,
};

// These assignments are compile-time authority proofs, not runtime fixtures.
const forbiddenSaveDraftInput: SaveDraftRevisionInput = {
  submissionId: "compile-time-submission",
  historicalAnswers: [],
  expectedCurrentRevisionId: null,
  // @ts-expect-error A caller must not acquire revision authority by adding effective answers.
  effectiveAnswers: [],
};
const forbiddenCreateDraftPinInput: CreateDraftSubmissionInput = {
  callId: "compile-time-call",
  // @ts-expect-error Draft pins and lifecycle state are derived by the server.
  pinnedFormVersionId: "compile-time-form",
};
const forbiddenCreateDraftStateInput: CreateDraftSubmissionInput = {
  callId: "compile-time-call",
  // @ts-expect-error Draft lifecycle state is derived by the server.
  state: "SUBMITTED",
};
void SAVE_DRAFT_INPUT_KEYS;
void CREATE_DRAFT_INPUT_KEYS;
void forbiddenSaveDraftInput;
void forbiddenCreateDraftPinInput;
void forbiddenCreateDraftStateInput;

function removeSqliteFiles(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    rmSync(target, { force: true });
  }
}

function waitForMarker(path: string): void {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) {
    Atomics.wait(waitCell, 0, 0, 10);
  }
}

function workspaceAndAccount(db: Db): OrganizerContext {
  const workspace = db.prepare("SELECT id FROM workspaces WHERE slug = 'northstar'").get() as { id: string };
  const account = db
    .prepare("SELECT id FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1")
    .get(workspace.id) as { id: string };
  return { workspaceId: workspace.id, accountId: account.id };
}

function insertApplicantFixture(
  db: Db,
  workspaceId: string,
  callId: string,
  prefix = "persistence",
  identifiers?: {
    readonly personId?: string;
    readonly verificationId?: string;
    readonly sessionId?: string;
  },
): { personId: string; sessionId: string; callId: string } {
  const personId = identifiers?.personId ?? `${prefix}-person`;
  const email = `${prefix}@synthetic.example`;
  db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(personId, workspaceId, email, "Synthetic Applicant", "2026-08-10T00:00:00.000Z");

  const verificationId = identifiers?.verificationId ?? `${prefix}-verification`;
  const sessionId = identifiers?.sessionId ?? `${prefix}-session`;
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verificationId,
    workspaceId,
    callId,
    email,
    "a".repeat(64),
    "2099-08-10T00:00:00.000Z",
    "2026-08-10T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`${prefix}-consumption`, workspaceId, verificationId, personId, "2026-08-10T00:00:00.000Z");
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    workspaceId,
    callId,
    personId,
    verificationId,
    "b".repeat(64),
    "2026-08-10T00:00:00.000Z",
    "2099-08-10T00:00:00.000Z",
  );
  return { personId, sessionId, callId };
}

function fixture(db: Db, rules: unknown = { schema: FORM_RULES_SCHEMA, rules: [] }) {
  const organizer = workspaceAndAccount(db);
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "persistence-event",
    organizer.workspaceId,
    "Synthetic CFP event",
    "UTC",
    "2026-09-15T09:00:00.000Z",
    "2026-09-15T10:00:00.000Z",
    "2026-08-10T00:00:00.000Z",
  );
  const definition = createFormDefinition(db, organizer, { name: "Synthetic CFP" });
  const form = sealFormVersion(db, organizer, {
    formDefinitionId: definition.id,
    fields: [
      { id: "trigger", type: "shortText", label: "Trigger", required: false, defaultVisibility: "visible" },
      { id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" },
       { id: "hiddenConsent", type: "acknowledgement", label: "Hidden consent", required: false, defaultVisibility: "hidden" },
       { id: "coSpeaker", type: "coSpeakerReference", label: "Co-speaker", required: false, defaultVisibility: "visible" },
       { id: "nestedMatrix", type: "matrix", label: "Nested matrix", required: false, defaultVisibility: "visible" },
    ],
    rules,
  });
  const policy = {
    disclosure: {
      privacy: "privacy",
      retention: "retention",
      aiProcessing: "ai",
      communication: "communication",
      consent: "consent",
      publication: "publication",
    },
    choices: [{ fieldId: "consent", statement: "Allow publication", required: true }],
  };
  const call = createCall(db, organizer, {
    eventId: "persistence-event",
    name: "Synthetic call",
    slug: "synthetic-call",
    formVersionId: form.id,
    policy,
  });
  const applicant = insertApplicantFixture(db, organizer.workspaceId, call.id);
  const submission = createDraftSubmission(
    db,
    { workspaceId: organizer.workspaceId, sessionId: applicant.sessionId },
    { callId: call.id },
  );
  return { organizer, form, call, applicant, submission };
}

function orderedReceiptFixture(db: Db) {
  const organizer = workspaceAndAccount(db);
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "receipt-matrix-event",
    organizer.workspaceId,
    "Receipt matrix event",
    "UTC",
    "2026-09-15T09:00:00.000Z",
    "2026-09-15T10:00:00.000Z",
    "2026-08-10T00:00:00.000Z",
  );
  const definition = createFormDefinition(db, organizer, { name: "Receipt matrix form" });
  const form = sealFormVersion(db, organizer, {
    formDefinitionId: definition.id,
    fields: [
      { id: "firstConsent", type: "consent", label: "First", required: false, defaultVisibility: "visible" },
      { id: "secondConsent", type: "policyAcceptance", label: "Second", required: false, defaultVisibility: "visible" },
    ],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const call = createCall(db, organizer, {
    eventId: "receipt-matrix-event",
    name: "Receipt matrix call",
    slug: "receipt-matrix-call",
    formVersionId: form.id,
    policy: {
      disclosure: {
        privacy: "privacy",
        retention: "retention",
        aiProcessing: "ai",
        communication: "communication",
        consent: "consent",
        publication: "publication",
      },
      choices: [
        { fieldId: "secondConsent", statement: "Second", required: true },
        { fieldId: "firstConsent", statement: "First", required: false },
      ],
    },
  });
  const applicant = insertApplicantFixture(db, organizer.workspaceId, call.id, "receipt-matrix");
  const submission = createDraftSubmission(db, {
    workspaceId: organizer.workspaceId,
    sessionId: applicant.sessionId,
  }, { callId: call.id });
  return { organizer, form, call, applicant, submission };
}

function revisionTruthSnapshot(db: Db, submissionId: string): {
  readonly formDefinitions: readonly unknown[];
  readonly forms: readonly unknown[];
  readonly rules: readonly unknown[];
  readonly calls: readonly unknown[];
  readonly sessions: readonly unknown[];
  readonly submission: unknown;
  readonly revisions: readonly unknown[];
} {
  return {
    formDefinitions: db.prepare("SELECT * FROM form_definitions ORDER BY id").all(),
    forms: db.prepare("SELECT * FROM form_versions ORDER BY id").all(),
    rules: db.prepare("SELECT * FROM rule_versions ORDER BY id").all(),
    calls: db.prepare("SELECT * FROM calls ORDER BY id").all(),
    sessions: db.prepare("SELECT * FROM cfp_applicant_sessions ORDER BY id").all(),
    submission: db.prepare("SELECT * FROM submissions WHERE id = ?").get(submissionId),
    revisions: db.prepare(
      `SELECT * FROM submission_revisions WHERE submission_id = ? ORDER BY revision_number`,
    ).all(submissionId),
  };
}

function expectAllRevisionReadSeamsToRejectWithoutWrite(
  db: Db,
  workspaceId: string,
  submissionId: string,
  revisionId: string,
  code: string,
): void {
  const reads = [
    () => readSubmissionRevision(db, workspaceId, revisionId),
    () => readSubmissionRevisionDocument(db, workspaceId, revisionId),
    () => readCurrentSubmissionRevision(db, workspaceId, submissionId),
    () => readCurrentSubmissionDocument(db, workspaceId, submissionId),
  ];
  for (const read of reads) {
    const before = revisionTruthSnapshot(db, submissionId);
    expect(read).toThrowError(expect.objectContaining({ code }));
    expect(revisionTruthSnapshot(db, submissionId)).toEqual(before);
  }
}

function revisionEnvelopeBytes(
  submissionId: string,
  revisionNumber: number,
  formDocument: unknown,
  callPolicy: unknown,
  consentReceipt: unknown,
): number {
  const content = {
    schema: CFP_SUBMISSION_REVISION_SCHEMA,
    submissionId,
    revisionNumber,
    formDocument,
    callPolicy,
    consentReceipt,
    fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
  } as const;
  return Buffer.byteLength(canonicalJson({ ...content, fingerprint: fingerprintOf(content) }), "utf8");
}

function policySnapshotForSize(
  policyVersionId: string,
  disclosure: Record<string, unknown>,
  choices: readonly { readonly fieldId: string; readonly statement: string; readonly required: boolean }[],
): unknown {
  const artifact = {
    schema: CFP_CALL_POLICY_SCHEMA,
    policyVersionId,
    disclosure,
    choices,
  } as const;
  return {
    ...artifact,
    fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
    fingerprint: fingerprintOf(artifact),
  };
}

function nestedValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

const REVISION_ROW_COLUMNS = [
  "workspace_id",
  "submission_id",
  "revision_number",
  "revision_schema",
  "revision_json",
  "form_version_id",
  "rule_version_id",
  "form_document_schema",
  "form_document_fingerprint",
  "policy_schema",
  "policy_version_id",
  "policy_fingerprint_algorithm",
  "policy_fingerprint",
  "consent_receipt_schema",
  "consent_receipt_policy_fingerprint",
  "session_id",
  "person_id",
  "fingerprint_algorithm",
  "fingerprint",
  "created_at",
] as const;

function insertCanonicalRevisionCandidate(
  db: Db,
  sourceRevisionId: string,
  candidateId: string,
  revisionNumber: number,
): void {
  const source = db.prepare("SELECT * FROM submission_revisions WHERE id = ?").get(sourceRevisionId) as Record<string, unknown>;
  const parsed = JSON.parse(String(source.revision_json)) as Record<string, unknown>;
  const { fingerprint: _sourceFingerprint, ...content } = parsed;
  const candidateContent = { ...content, revisionNumber };
  const candidate = { ...candidateContent, fingerprint: fingerprintOf(candidateContent) };
  const values = REVISION_ROW_COLUMNS.map((column) => {
    if (column === "revision_number") return revisionNumber;
    if (column === "revision_json") return canonicalJson(candidate);
    if (column === "fingerprint") return candidate.fingerprint;
    return source[column];
  });
  db.prepare(
    `INSERT INTO submission_revisions (id, ${REVISION_ROW_COLUMNS.join(", ")})
     VALUES (?, ${REVISION_ROW_COLUMNS.map(() => "?").join(", ")})`,
  ).run(candidateId, ...(values as never[]));
}

function insertRevisionRowWithJson(
  db: Db,
  source: Record<string, unknown>,
  candidateId: string,
  revisionJson: string,
  fingerprint: string,
  revisionNumber = Number(source.revision_number),
): void {
  const values = REVISION_ROW_COLUMNS.map((column) => {
    if (column === "revision_number") return revisionNumber;
    if (column === "revision_json") return revisionJson;
    if (column === "fingerprint") return fingerprint;
    return source[column];
  });
  db.prepare(
    `INSERT INTO submission_revisions (id, ${REVISION_ROW_COLUMNS.join(", ")})
     VALUES (?, ${REVISION_ROW_COLUMNS.map(() => "?").join(", ")})`,
  ).run(candidateId, ...(values as never[]));
}

describe("CFP evaluator-coupled persistence", () => {
  it("persists exact evaluator output inside the outer revision envelope", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(
        db,
        { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId },
        {
          submissionId: data.submission.id,
          historicalAnswers: [
            { fieldId: "coSpeaker", value: "reference-only" },
            { fieldId: "consent", value: true },
            { fieldId: "trigger", value: "go" },
          ],
          expectedCurrentRevisionId: null,
        },
      );

      expect(saved.revision.schema).toBe(CFP_SUBMISSION_REVISION_SCHEMA);
      expect(saved.revision.formDocument.schema).toBe(FORM_DOCUMENT_SCHEMA);
       expect(saved.revision.formDocument.historicalAnswers.map((answer) => answer.fieldId)).toEqual([
         "coSpeaker",
         "consent",
         "trigger",
       ].sort());
       expect(saved.revision.formDocument.fields.map((field) => field.id)).toEqual([
         "trigger",
         "consent",
         "hiddenConsent",
         "coSpeaker",
         "nestedMatrix",
       ]);
      expect(saved.revision.formDocument.effectiveAnswers.map((answer) => answer.fieldId)).toEqual([
        "coSpeaker",
        "consent",
        "trigger",
      ]);
      expect(saved.revision.callPolicy.schema).toBe(CFP_CALL_POLICY_SCHEMA);
      expect(saved.revision.consentReceipt?.schema).toBe(CFP_CONSENT_RECEIPT_SCHEMA);
      expect(saved.revision.consentReceipt?.choices).toEqual([{ fieldId: "consent", value: true }]);
      expect(Object.isFrozen(saved.revision)).toBe(true);
      expect(Object.isFrozen(saved.revision.formDocument)).toBe(true);


      const stored = db
        .prepare("SELECT revision_json, revision_schema, fingerprint FROM submission_revisions WHERE id = ?")
        .get(saved.revisionId) as { revision_json: string; revision_schema: string; fingerprint: string };
      expect(stored.revision_schema).toBe(CFP_SUBMISSION_REVISION_SCHEMA);
      expect(stored.revision_json).toBe(canonicalJson(saved.revision));
      expect(stored.fingerprint).toBe(saved.revision.fingerprint);
      expect(readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toEqual(saved.revision);
      expect(readSubmissionRevisionDocument(db, data.organizer.workspaceId, saved.revisionId)).toEqual(
        saved.revision.formDocument,
      );
      expect(readFormVersionDocument(db, data.organizer.workspaceId, data.form.id).historicalAnswers).toEqual([]);
      db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id);
      expect(db.prepare("SELECT state FROM submissions WHERE id = ?").get(data.submission.id)).toEqual({
        state: "SUBMITTED",
      });
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["malformed", { schema: FORM_RULES_SCHEMA, rules: [{ malformed: true }] }, "FORM_RULE_INVALID"],
    ["field mismatch", {
      schema: FORM_RULES_SCHEMA,
      rules: [{
        id: "missing-target",
        condition: { kind: "field", fieldId: "trigger", operator: "isEmpty" },
        actions: [{ type: "show", targetFieldId: "missing" }],
      }],
    }, "FORM_RULE_TARGET_UNKNOWN"],
    ["unknown schema", { schema: "unknown-rules-schema", rules: [] }, "FORM_RULES_SCHEMA_UNSUPPORTED"],
    ["caller algorithm", { schema: FORM_RULES_SCHEMA, rules: [], algorithm: "forged" }, "PERSISTENCE_INPUT_INVALID"],
    ["caller fingerprint", { schema: FORM_RULES_SCHEMA, rules: [], fingerprint: "0".repeat(64) }, "PERSISTENCE_INPUT_INVALID"],
  ] as const)("rejects %s rule input before either sealed artifact is written", (_name, rules, code) => {
    const db = openDb({ path: ":memory:" });
    try {
      const organizer = workspaceAndAccount(db);
      const definition = createFormDefinition(db, organizer, { name: `Rule matrix ${_name}` });
      const before = {
        rules: db.prepare("SELECT * FROM rule_versions ORDER BY id").all(),
        forms: db.prepare("SELECT * FROM form_versions ORDER BY id").all(),
      };
      expect(() => sealFormVersion(db, organizer, {
        formDefinitionId: definition.id,
        fields: [
          { id: "trigger", type: "shortText", label: "Trigger", required: false, defaultVisibility: "visible" },
          { id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" },
        ],
        rules,
      })).toThrowError(expect.objectContaining({ code }));
      expect({
        rules: db.prepare("SELECT * FROM rule_versions ORDER BY id").all(),
        forms: db.prepare("SELECT * FROM form_versions ORDER BY id").all(),
      }).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it("detaches caller input and deeply freezes the complete revision snapshot", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const currentPolicy = readCall(db, data.organizer.workspaceId, data.call.id);
      updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: currentPolicy.fingerprint,
        policy: {
          disclosure: {
            privacy: { terms: [{ leaf: "privacy" }] },
            retention: "retention",
            aiProcessing: "ai",
            communication: "communication",
            consent: "consent",
            publication: "publication",
          },
          choices: currentPolicy.choices,
        },
      });
      const nestedAnswerValue = { details: [{ leaf: "original" }] };
      const historicalAnswers: Array<{ fieldId: string; value: unknown }> = [
        { fieldId: "consent", value: true },
        { fieldId: "nestedMatrix", value: nestedAnswerValue },
      ];
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers,
        expectedCurrentRevisionId: null,
      });
      nestedAnswerValue.details[0]!.leaf = "caller-mutated";
      historicalAnswers[0]!.value = false;
      historicalAnswers.push({ fieldId: "trigger", value: "detached" });
      expect(saved.revision.formDocument.historicalAnswers).toEqual([
        { fieldId: "consent", value: true },
        { fieldId: "nestedMatrix", value: { details: [{ leaf: "original" }] } },
      ]);
      expect(readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toEqual(saved.revision);
      const nestedSavedAnswer = saved.revision.formDocument.historicalAnswers.find(
        (answer) => answer.fieldId === "nestedMatrix",
      );
      if (!nestedSavedAnswer || typeof nestedSavedAnswer.value !== "object" || nestedSavedAnswer.value === null) {
        throw new Error("expected nested matrix answer");
      }
      expect(Object.isFrozen(saved.revision.formDocument.fields[0])).toBe(true);
      expect(Object.isFrozen(saved.revision.formDocument.historicalAnswers[0])).toBe(true);
      expect(Object.isFrozen(nestedSavedAnswer)).toBe(true);
      expect(Object.isFrozen(nestedSavedAnswer.value)).toBe(true);
      expect(Object.isFrozen((nestedSavedAnswer.value as { details: unknown[] }).details)).toBe(true);
      expect(Object.isFrozen((nestedSavedAnswer.value as { details: unknown[] }).details[0])).toBe(true);
      expect(Object.isFrozen(saved.revision.formDocument.effectiveAnswers[0])).toBe(true);
      expect(Object.isFrozen(saved.revision.callPolicy)).toBe(true);
      expect(Object.isFrozen(saved.revision.callPolicy.disclosure)).toBe(true);
      expect(Object.isFrozen((saved.revision.callPolicy.disclosure.privacy as { terms: unknown[] }).terms)).toBe(true);
      expect(Object.isFrozen((saved.revision.callPolicy.disclosure.privacy as { terms: unknown[] }).terms[0])).toBe(true);
      expect(Object.isFrozen(saved.revision.callPolicy.choices)).toBe(true);
      expect(Object.isFrozen(saved.revision.callPolicy.choices[0])).toBe(true);
      expect(Object.isFrozen(saved.revision.consentReceipt)).toBe(true);
      expect(Object.isFrozen(saved.revision.consentReceipt?.choices)).toBe(true);
      expect(Object.isFrozen(saved.revision.consentReceipt?.choices[0])).toBe(true);
    } finally {
      closeDb(db);
    }
  });

  it("accepts optional false consent and preserves ordered two-choice receipts", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const organizer = workspaceAndAccount(db);
      db.prepare(
        `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
         VALUES ('ordered-event', ?, 'Ordered event', 'UTC', ?, ?, ?)`,
      ).run(
        organizer.workspaceId,
        "2026-09-15T09:00:00.000Z",
        "2026-09-15T10:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
      );
      const definition = createFormDefinition(db, organizer, { name: "Ordered form" });
      const form = sealFormVersion(db, organizer, {
        formDefinitionId: definition.id,
        fields: [
          { id: "firstConsent", type: "consent", label: "First", required: false, defaultVisibility: "visible" },
          { id: "secondConsent", type: "policyAcceptance", label: "Second", required: false, defaultVisibility: "visible" },
        ],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      const call = createCall(db, organizer, {
        eventId: "ordered-event",
        name: "Ordered call",
        slug: "ordered-call",
        formVersionId: form.id,
        policy: {
          disclosure: {
            privacy: "privacy",
            retention: "retention",
            aiProcessing: "ai",
            communication: "communication",
            consent: "consent",
            publication: "publication",
          },
          choices: [
            { fieldId: "secondConsent", statement: "Second", required: false },
            { fieldId: "firstConsent", statement: "First", required: false },
          ],
        },
      });
      const applicant = insertApplicantFixture(db, organizer.workspaceId, call.id, "ordered");
      const submission = createDraftSubmission(
        db,
        { workspaceId: organizer.workspaceId, sessionId: applicant.sessionId },
        { callId: call.id },
      );
      const saved = saveDraftRevision(db, {
        workspaceId: organizer.workspaceId,
        sessionId: applicant.sessionId,
      }, {
        submissionId: submission.id,
        historicalAnswers: [
          { fieldId: "firstConsent", value: false },
          { fieldId: "secondConsent", value: true },
        ],
        expectedCurrentRevisionId: null,
      });
      expect(saved.revision.consentReceipt?.choices).toEqual([
        { fieldId: "secondConsent", value: true },
        { fieldId: "firstConsent", value: false },
      ]);
      db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(submission.id);
      expect(db.prepare("SELECT state FROM submissions WHERE id = ?").get(submission.id)).toEqual({ state: "SUBMITTED" });
    } finally {
      closeDb(db);
    }
  });

  it("uses path-aware JSON guards for direct submitted transitions", () => {
    const emptyDb = openDb({ path: ":memory:" });
    try {
      const data = fixture(emptyDb);
      const current = readCall(emptyDb, data.organizer.workspaceId, data.call.id);
      updateCallPolicy(emptyDb, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: current.fingerprint,
        policy: { disclosure: current.disclosure, choices: [] },
      });
      const saved = saveDraftRevision(emptyDb, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      expect(saved.revision.consentReceipt?.choices).toEqual([]);
      expect(() => emptyDb.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).not.toThrow();
      expect(emptyDb.prepare("SELECT state FROM submissions WHERE id = ?").get(data.submission.id)).toEqual({
        state: "SUBMITTED",
      });
    } finally {
      closeDb(emptyDb);
    }

    const stringDb = openDb({ path: ":memory:" });
    try {
      const data = fixture(stringDb);
      const saved = saveDraftRevision(stringDb, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const stored = stringDb.prepare("SELECT policy_json FROM calls WHERE id = ?").get(data.call.id) as {
        policy_json: string;
      };
      const forgedPolicy = JSON.parse(stored.policy_json) as Record<string, unknown>;
      forgedPolicy.choices = "[]";
      stringDb.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      stringDb.prepare("UPDATE calls SET policy_json = ? WHERE id = ?").run(
        canonicalJson(forgedPolicy),
        data.call.id,
      );
      stringDb.exec(DDL);
      expect(() => stringDb.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      expect(stringDb.prepare("SELECT state, current_revision_id FROM submissions WHERE id = ?").get(data.submission.id)).toEqual({
        state: "DRAFT",
        current_revision_id: saved.revisionId,
      });
    } finally {
      closeDb(stringDb);
    }
  });

  it("proves the valid receipt ceiling and rejects an oversized hostile stored receipt independently", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const organizer = workspaceAndAccount(db);
      db.prepare(
        `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
         VALUES ('receipt-ceiling-event', ?, 'Receipt ceiling event', 'UTC', ?, ?, ?)`,
      ).run(
        organizer.workspaceId,
        "2026-09-15T09:00:00.000Z",
        "2026-09-15T10:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
      );
      const fieldIds = Array.from({ length: 256 }, (_, index) =>
        `c${String(index).padStart(3, "0")}${"x".repeat(124)}`,
      );
      const definition = createFormDefinition(db, organizer, { name: "Receipt ceiling form" });
      const form = sealFormVersion(db, organizer, {
        formDefinitionId: definition.id,
        fields: fieldIds.map((id) => ({
          id,
          type: "consent" as const,
          label: "Consent",
          required: false,
          defaultVisibility: "visible" as const,
        })),
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      const call = createCall(db, organizer, {
        eventId: "receipt-ceiling-event",
        name: "Receipt ceiling call",
        slug: "receipt-ceiling-call",
        formVersionId: form.id,
        policy: {
          disclosure: {
            privacy: "privacy",
            retention: "retention",
            aiProcessing: "ai",
            communication: "communication",
            consent: "consent",
            publication: "publication",
          },
          choices: fieldIds.map((fieldId) => ({ fieldId, statement: "s", required: false })),
        },
      });
       const applicant = insertApplicantFixture(db, organizer.workspaceId, call.id, "receipt-ceiling", {
         personId: "p".repeat(128),
         verificationId: "v".repeat(128),
         sessionId: "s".repeat(128),
       });
       const submissionIds = ["d".repeat(128), "r".repeat(128)];
       const ceilingPersistence = createCfpPersistence({ idGenerator: () => {
         const next = submissionIds.shift();
         if (!next) throw new Error("missing deterministic ceiling ID");
         return next;
       } });
       const submission = ceilingPersistence.createDraftSubmission(db, {
         workspaceId: organizer.workspaceId,
         sessionId: applicant.sessionId,
       }, { callId: call.id });
       const saved = ceilingPersistence.saveDraftRevision(db, {
         workspaceId: organizer.workspaceId,
         sessionId: applicant.sessionId,
       }, {
         submissionId: submission.id,
         historicalAnswers: fieldIds.map((fieldId) => ({ fieldId, value: false })),
         expectedCurrentRevisionId: null,
       });
       expect(submission.id).toHaveLength(128);
       expect(applicant.personId).toHaveLength(128);
       expect(applicant.sessionId).toHaveLength(128);
       expect(saved.revision.consentReceipt?.choices.every((choice) => choice.value === false)).toBe(true);
       expect(saved.revision.consentReceipt?.choices.every((choice) => choice.fieldId.length === 128)).toBe(true);
      const receiptBytes = Buffer.byteLength(canonicalJson(saved.revision.consentReceipt), "utf8");
       expect(receiptBytes).toBeLessThan(LITERAL_RECEIPT_LIMIT);
       expect(receiptBytes).toBeGreaterThan(32 * 1024);

      const parsed = JSON.parse(
        (db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
          revision_json: string;
        }).revision_json,
      ) as Record<string, unknown>;
      const originalReceipt = parsed.consentReceipt as Record<string, unknown>;
      const hostileReceipt = {
        ...originalReceipt,
        choices: Array.from({ length: 512 }, (_, index) => ({
          fieldId: fieldIds[index % fieldIds.length],
          value: true,
        })),
      };
      const content = { ...parsed, consentReceipt: hostileReceipt, fingerprint: undefined };
      delete content.fingerprint;
      const hostile = { ...content, fingerprint: fingerprintOf(content) };
      expect(Buffer.byteLength(canonicalJson(hostileReceipt), "utf8")).toBeGreaterThan(LITERAL_RECEIPT_LIMIT);
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(hostile),
        hostile.fingerprint,
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readSubmissionRevision(db, organizer.workspaceId, saved.revisionId)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_OVERSIZED" }),
      );
    } finally {
      closeDb(db);
    }
  });

  it("proves independent depth 32/33 form-policy and outer-envelope safety boundaries", () => {
    expect(() => sanitizeFormData(nestedValue(32))).not.toThrow();
    expect(() => sanitizeFormData(nestedValue(33))).toThrowError(
      expect.objectContaining({ code: "DEPTH_LIMIT" }),
    );

    const formEnvelope = {
      schema: CFP_SUBMISSION_REVISION_SCHEMA,
      submissionId: "depth-submission",
      revisionNumber: 1,
      formDocument: {
        schema: FORM_DOCUMENT_SCHEMA,
        formVersionId: "depth-form",
        ruleVersionId: "depth-rule",
        fields: [],
        historicalAnswers: [],
        effectiveAnswers: [],
        fingerprint: "0".repeat(64),
      },
      callPolicy: {
        schema: CFP_CALL_POLICY_SCHEMA,
        policyVersionId: "depth-policy",
        disclosure: {
          privacy: nestedValue(29),
          retention: "retention",
          aiProcessing: "ai",
          communication: "communication",
          consent: "consent",
          publication: "publication",
        },
        choices: [],
        fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
        fingerprint: "0".repeat(64),
      },
      consentReceipt: null,
      fingerprintAlgorithm: CFP_FINGERPRINT_ALGORITHM,
      fingerprint: "0".repeat(64),
    };
    expect(() => sanitizeFormData(formEnvelope)).not.toThrow();
    expect(() => sanitizeFormData({
      ...formEnvelope,
      callPolicy: {
        ...formEnvelope.callPolicy,
        disclosure: {
          ...formEnvelope.callPolicy.disclosure,
          privacy: nestedValue(30),
        },
      },
    })).toThrowError(expect.objectContaining({ code: "DEPTH_LIMIT" }));
  });

  it("proves actual form and policy depth 32 success, depth 33 rejection, and a distinct outer read boundary", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const context = { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId };
      const formAtDepth32 = saveDraftRevision(db, context, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "nestedMatrix", value: nestedValue(29) }],
        expectedCurrentRevisionId: null,
      });
      expect(formAtDepth32.revision.formDocument.historicalAnswers[0]?.value).toEqual(nestedValue(29));
      const beforeFormFailure = revisionTruthSnapshot(db, data.submission.id);
      expect(() => saveDraftRevision(db, context, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "nestedMatrix", value: nestedValue(30) }],
        expectedCurrentRevisionId: formAtDepth32.revisionId,
      })).toThrowError(expect.objectContaining({ code: "DEPTH_LIMIT" }));
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforeFormFailure);

      const current = readCall(db, data.organizer.workspaceId, data.call.id);
      const policyAtDepth32 = updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: current.fingerprint,
        policy: {
          disclosure: {
            ...current.disclosure,
            privacy: nestedValue(29),
          },
          choices: current.choices,
        },
      });
      expect(policyAtDepth32.disclosure.privacy).toEqual(nestedValue(29));
      const beforePolicyFailure = revisionTruthSnapshot(db, data.submission.id);
      expect(() => updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: policyAtDepth32.fingerprint,
        policy: {
          disclosure: {
            ...policyAtDepth32.disclosure,
            privacy: nestedValue(30),
          },
          choices: policyAtDepth32.choices,
        },
      })).toThrowError(expect.objectContaining({ code: "DEPTH_LIMIT" }));
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforePolicyFailure);

      const policyForOuter = policyAtDepth32;
      const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(formAtDepth32.revisionId) as {
        revision_json: string;
      };
      const parsed = JSON.parse(row.revision_json) as Record<string, unknown>;
      const originalPolicy = parsed.callPolicy as Record<string, unknown>;
      const alteredPolicyBase: Record<string, unknown> = {
        ...originalPolicy,
        disclosure: {
          ...(originalPolicy.disclosure as Record<string, unknown>),
          privacy: nestedValue(30),
        },
      };
      const alteredPolicyArtifact = {
        schema: alteredPolicyBase.schema,
        policyVersionId: alteredPolicyBase.policyVersionId,
        disclosure: alteredPolicyBase.disclosure,
        choices: alteredPolicyBase.choices,
      };
      const alteredPolicy = {
        ...alteredPolicyBase,
        fingerprint: fingerprintOf(alteredPolicyArtifact),
      };
      const alteredContent: Record<string, unknown> = { ...parsed, callPolicy: alteredPolicy };
      delete alteredContent.fingerprint;
      const altered = { ...alteredContent, fingerprint: fingerprintOf(alteredContent) };
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(altered),
        altered.fingerprint,
        formAtDepth32.revisionId,
      );
      db.exec(DDL);
      const beforeOuterRead = revisionTruthSnapshot(db, data.submission.id);
      expect(() => readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforeOuterRead);
      expect(policyForOuter.fingerprint).not.toBe(alteredPolicy.fingerprint);
    } finally {
      closeDb(db);
    }
  });

  it("does not expose caller-owned effective answers or revision identity", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const before = revisionTruthSnapshot(db, data.submission.id);
      expect(() =>
        saveDraftRevision(
          db,
          { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId },
          {
            submissionId: data.submission.id,
            historicalAnswers: [{ fieldId: "consent", value: true }],
            expectedCurrentRevisionId: null,
            // @ts-expect-error Deliberately proves the public input cannot carry a subset.
            effectiveAnswers: [],
          },
        ),
      ).toThrowError(expect.objectContaining({ code: "PERSISTENCE_INPUT_INVALID" }));
       expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
      expect(() =>
        saveDraftRevision(
          db,
          { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId },
          {
            submissionId: data.submission.id,
            historicalAnswers: [{ fieldId: "consent", value: "not-boolean" }],
            expectedCurrentRevisionId: null,
          },
        ),
      ).toThrow();
       expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["effective answers", "effectiveAnswers", []],
    ["revision ID", "revisionId", "forged-revision"],
    ["revision number", "revisionNumber", 2],
    ["form pin", "formVersionId", "forged-form"],
    ["rule pin", "ruleVersionId", "forged-rule"],
    ["actor", "actorId", "forged-actor"],
    ["person", "personId", "forged-person"],
    ["session", "sessionId", "forged-session"],
    ["timestamp", "createdAt", "2026-08-10T00:00:00.000Z"],
    ["policy hash", "policyFingerprint", "0".repeat(64)],
    ["policy snapshot", "callPolicy", {}],
    ["receipt", "consentReceipt", null],
    ["choices", "choices", []],
    ["algorithm", "fingerprintAlgorithm", "forged-algorithm"],
    ["fingerprint", "fingerprint", "0".repeat(64)],
  ] as const)("rejects caller-authoritative %s and writes nothing", (_name, key, value) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const before = revisionTruthSnapshot(db, data.submission.id);
      const input = {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
        [key]: value,
      } as unknown;
      expect(() => saveDraftRevision(
        db,
        { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId },
        input as never,
      )).toThrowError(expect.objectContaining({ code: "PERSISTENCE_INPUT_INVALID" }));
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["unknown policy keys", { schema: CFP_CALL_POLICY_SCHEMA, disclosure: {}, choices: [] }, "CALL_POLICY_INVALID"],
    ["duplicate choices", {
      disclosure: {
        privacy: "privacy", retention: "retention", aiProcessing: "ai",
        communication: "communication", consent: "consent", publication: "publication",
      },
      choices: [
        { fieldId: "consent", statement: "one", required: false },
        { fieldId: "consent", statement: "two", required: false },
      ],
    }, "CALL_POLICY_INVALID"],
       ["unknown choice field", {
      disclosure: {
        privacy: "privacy", retention: "retention", aiProcessing: "ai",
        communication: "communication", consent: "consent", publication: "publication",
      },
      choices: [{ fieldId: "missing", statement: "missing", required: false }],
       }, "CALL_POLICY_INVALID"],
       ["empty choice field", {
         disclosure: {
           privacy: "privacy", retention: "retention", aiProcessing: "ai",
           communication: "communication", consent: "consent", publication: "publication",
         },
         choices: [{ fieldId: "", statement: "empty", required: false }],
       }, "CALL_POLICY_INVALID"],
    ["non-consent choice field", {
      disclosure: {
        privacy: "privacy", retention: "retention", aiProcessing: "ai",
        communication: "communication", consent: "consent", publication: "publication",
      },
      choices: [{ fieldId: "trigger", statement: "not consent", required: false }],
    }, "CALL_POLICY_INVALID"],
    ["empty choice statement", {
      disclosure: {
        privacy: "privacy", retention: "retention", aiProcessing: "ai",
        communication: "communication", consent: "consent", publication: "publication",
      },
      choices: [{ fieldId: "consent", statement: " ", required: false }],
    }, "CALL_POLICY_INVALID"],
  ] as const)("rejects %s policy shape without persistence", (_name, policy, code) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const before = db.prepare("SELECT COUNT(*) AS count FROM calls").get();
      expect(() => createCall(db, data.organizer, {
        eventId: "persistence-event",
        name: `Malformed ${_name}`,
        slug: `malformed-${_name.replaceAll(" ", "-")}`,
        formVersionId: data.form.id,
        policy,
      })).toThrowError(expect.objectContaining({ code }));
      expect(db.prepare("SELECT COUNT(*) AS count FROM calls").get()).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it("rejects both mixed-null receipt mirror tuples at the SQL boundary", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const receipt = saved.revision.consentReceipt;
      if (!receipt) {
        throw new Error("expected a consent receipt");
      }
      const attempts = [
        { consent_receipt_schema: null, consent_receipt_policy_fingerprint: receipt.policyFingerprint },
        { consent_receipt_schema: receipt.schema, consent_receipt_policy_fingerprint: null },
      ] as const;
      for (const attempt of attempts) {
        db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
        expect(() => db.prepare(
          `UPDATE submission_revisions
           SET consent_receipt_schema = ?, consent_receipt_policy_fingerprint = ?
           WHERE id = ?`,
        ).run(attempt.consent_receipt_schema, attempt.consent_receipt_policy_fingerprint, saved.revisionId)).toThrow();
        db.exec(DDL);
        expect(db.prepare(
          "SELECT consent_receipt_schema, consent_receipt_policy_fingerprint FROM submission_revisions WHERE id = ?",
        ).get(saved.revisionId)).toEqual({
          consent_receipt_schema: receipt.schema,
          consent_receipt_policy_fingerprint: receipt.policyFingerprint,
        });
      }
    } finally {
      closeDb(db);
    }
  });

  it("rejects both mixed-null receipt mirror tuples at the revision INSERT seam", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const source = db.prepare("SELECT * FROM submission_revisions WHERE id = ?").get(saved.revisionId) as Record<string, unknown>;
      const receipt = saved.revision.consentReceipt;
      if (!receipt) {
        throw new Error("expected a consent receipt");
      }
      db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_no_delete");
      db.prepare("UPDATE submissions SET current_revision_id = NULL WHERE id = ?").run(data.submission.id);
      db.prepare("DELETE FROM submission_revisions WHERE id = ?").run(saved.revisionId);
      db.exec(DDL);
      const attempts = [
        { consent_receipt_schema: null, consent_receipt_policy_fingerprint: receipt.policyFingerprint },
        { consent_receipt_schema: receipt.schema, consent_receipt_policy_fingerprint: null },
      ] as const;
      for (const [index, attempt] of attempts.entries()) {
        const before = revisionTruthSnapshot(db, data.submission.id);
        expect(() => insertRevisionRowWithJson(
          db,
          {
            ...source,
            consent_receipt_schema: attempt.consent_receipt_schema,
            consent_receipt_policy_fingerprint: attempt.consent_receipt_policy_fingerprint,
          },
          `mixed-null-insert-${index}`,
          String(source.revision_json),
          String(source.fingerprint),
        )).toThrow(/submission_revisions workspace mismatch/);
        expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
      }
    } finally {
      closeDb(db);
    }
  });

  it("retains ineffective history, omits it from E1 output, and rolls back evaluation failures", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db, {
        schema: FORM_RULES_SCHEMA,
        rules: [
          {
            id: "hide-consent",
            condition: { kind: "field", fieldId: "trigger", operator: "equals", value: "hide" },
            actions: [{ type: "hide", targetFieldId: "consent" }],
          },
        ],
      });
      const context = { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId };
      const saved = saveDraftRevision(db, context, {
        submissionId: data.submission.id,
        historicalAnswers: [
          { fieldId: "consent", value: true },
          { fieldId: "trigger", value: "hide" },
        ],
        expectedCurrentRevisionId: null,
      });
      expect(saved.revision.formDocument.historicalAnswers.map((answer) => answer.fieldId)).toEqual([
        "consent",
        "trigger",
      ]);
      expect(saved.revision.formDocument.effectiveAnswers.map((answer) => answer.fieldId)).toEqual(["trigger"]);
      expect(saved.revision.consentReceipt).toBeNull();

       const beforeFailure = revisionTruthSnapshot(db, data.submission.id);
      expect(() => saveDraftRevision(db, context, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: "not-a-boolean" }],
        expectedCurrentRevisionId: saved.revisionId,
      })).toThrowError(expect.objectContaining({ code: "FORM_HISTORICAL_ANSWER_VALUE_INVALID" }));
       expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforeFailure);
    } finally {
      closeDb(db);
    }
  });

  it("composes CFP commands inside an outer transaction with savepoint rollback and commit", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const organizer = workspaceAndAccount(db);
      const committed = withTransaction(db, () =>
        createFormDefinition(db, organizer, { name: "Nested committed form" }),
      );
      expect(db.prepare("SELECT name FROM form_definitions WHERE id = ?").get(committed.id)).toEqual({
        name: "Nested committed form",
      });
      const beforeRollback = db.prepare("SELECT COUNT(*) AS count FROM form_definitions").get();
      expect(() => withTransaction(db, () => {
        createFormDefinition(db, organizer, { name: "Nested rolled back form" });
        throw new Error("outer rollback");
      })).toThrow("outer rollback");
      expect(db.prepare("SELECT COUNT(*) AS count FROM form_definitions").get()).toEqual(beforeRollback);
      expect(db.isTransaction).toBe(false);

       const outerCommitted = withTransaction(db, () => {
          const definition = createFormDefinition(db, organizer, { name: "Savepoint evidence form" });
          const truthBefore = {
            definitions: db.prepare("SELECT * FROM form_definitions ORDER BY id").all(),
            rules: db.prepare("SELECT * FROM rule_versions ORDER BY id").all(),
            forms: db.prepare("SELECT * FROM form_versions ORDER BY id").all(),
          };
          const events: string[] = [];
          db.function("cfp_test_second_write", () => {
            events.push("second-write");
            return 1;
          });
          const observedDb = new Proxy(db, {
            get(target, property) {
              if (property === "exec") {
                return (sql: string) => {
                  if (sql === 'SAVEPOINT "cfp_seal_form_version"') {
                    events.push("savepoint");
                  }
                  return target.exec(sql);
                };
              }
              if (property === "prepare") {
                return (sql: string) => {
                  if (sql.includes("INSERT INTO rule_versions")) {
                    events.push("first-write");
                  }
                  return target.prepare(sql);
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as unknown as Db;
          db.exec(
            "CREATE TEMP TRIGGER cfp_test_abort_form_insert BEFORE INSERT ON form_versions BEGIN SELECT cfp_test_second_write(); SELECT RAISE(ABORT, 'test second write'); END",
          );
          expect(() => sealFormVersion(observedDb, organizer, {
            formDefinitionId: definition.id,
            fields: [{ id: "valid", type: "shortText", label: "Valid", required: false, defaultVisibility: "visible" }],
            rules: { schema: "cfp-form-rules/v1", rules: [] },
          })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_WRITE_FAILED" }));
          expect(events).toEqual(["savepoint", "first-write", "second-write"]);
          expect({
            definitions: db.prepare("SELECT * FROM form_definitions ORDER BY id").all(),
            rules: db.prepare("SELECT * FROM rule_versions ORDER BY id").all(),
            forms: db.prepare("SELECT * FROM form_versions ORDER BY id").all(),
          }).toEqual(truthBefore);
          db.exec("DROP TRIGGER cfp_test_abort_form_insert");
          const following = createFormDefinition(db, organizer, { name: "After caught seal failure" });
          return { definition, following };
        });
      expect(db.prepare("SELECT name FROM form_definitions WHERE id IN (?, ?) ORDER BY name").all(
        outerCommitted.definition.id,
        outerCommitted.following.id,
      )).toEqual([
        { name: "After caught seal failure" },
        { name: "Savepoint evidence form" },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM rule_versions WHERE form_definition_id = ?").get(
        outerCommitted.definition.id,
      )).toEqual({ count: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("uses CAS revision pointers and rejects direct submitted creation", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const context = { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId };
       const first = saveDraftRevision(db, context, {
        submissionId: data.submission.id,
        historicalAnswers: [],
         expectedCurrentRevisionId: null,
       });
       const beforeStale = revisionTruthSnapshot(db, data.submission.id);
       expect(() =>
         saveDraftRevision(db, context, {
          submissionId: data.submission.id,
          historicalAnswers: [{ fieldId: "consent", value: true }],
          expectedCurrentRevisionId: null,
         }),
       ).toThrowError(expect.objectContaining({ code: "STALE_REVISION" }));
       expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforeStale);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM submission_revisions WHERE submission_id = ?").get(data.submission.id),
      ).toEqual({ count: 1 });
      expect(() =>
        db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id),
      ).toThrow(/submissions current pointer mismatch/);
      expect(() =>
        db.prepare(
          `INSERT INTO submissions
             (id, workspace_id, event_id, call_id, owner_person_id, state,
              pinned_form_version_id, pinned_rule_version_id, current_revision_id, created_at, updated_at)
           VALUES ('forged-submission', ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?, ?, ?)`,
        ).run(
          data.organizer.workspaceId,
          "persistence-event",
          data.call.id,
          data.applicant.personId,
          data.form.id,
          data.form.ruleVersionId,
          first.revisionId,
          "2026-08-10T00:00:00.000Z",
          "2026-08-10T00:00:00.000Z",
        ),
      ).toThrow(/submissions must start as draft/);
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["revoked", (db: Db, data: ReturnType<typeof fixture>) => {
      db.prepare(
        "UPDATE cfp_applicant_sessions SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ?",
      ).run("2026-08-10T01:00:00.000Z", data.organizer.accountId, "synthetic revoke", data.applicant.sessionId);
    }, "SESSION_REVOKED"],
    ["expired", (db: Db, data: ReturnType<typeof fixture>) => {
      db.exec("DROP TRIGGER trg_cfp_applicant_sessions_core_immutable");
      db.prepare("UPDATE cfp_applicant_sessions SET expires_at = ? WHERE id = ?").run(
        "2026-08-10T00:00:00.001Z",
        data.applicant.sessionId,
      );
      db.exec(DDL);
    }, "SESSION_EXPIRED"],
    ["wrong owner", (db: Db, data: ReturnType<typeof fixture>) => {
      db.prepare(
        `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
         VALUES ('wrong-owner', ?, 'wrong-owner@synthetic.example', 'Wrong Owner', ?)`,
      ).run(data.organizer.workspaceId, "2026-08-10T00:00:00.000Z");
      db.exec("DROP TRIGGER trg_cfp_applicant_sessions_core_immutable");
      db.prepare("UPDATE cfp_applicant_sessions SET person_id = ? WHERE id = ?").run(
        "wrong-owner",
        data.applicant.sessionId,
      );
      db.exec(DDL);
    }, "SESSION_INVALID"],
    ["wrong call", (db: Db, data: ReturnType<typeof fixture>) => {
      const current = readCall(db, data.organizer.workspaceId, data.call.id);
      const otherCall = createCall(db, data.organizer, {
        eventId: "persistence-event",
        name: "Other call",
        slug: "other-call",
        formVersionId: data.form.id,
        policy: { disclosure: current.disclosure, choices: current.choices },
      });
      db.exec("DROP TRIGGER trg_cfp_applicant_sessions_core_immutable");
      db.prepare("UPDATE cfp_applicant_sessions SET call_id = ? WHERE id = ?").run(
        otherCall.id,
        data.applicant.sessionId,
      );
      db.exec(DDL);
    }, "SESSION_INVALID"],
  ] as const)("fails closed for a %s applicant session", (_name, mutate, code) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      mutate(db, data);
      expect(() => saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      })).toThrowError(expect.objectContaining({ code }));
      expect(db.prepare("SELECT COUNT(*) AS count FROM submission_revisions").get()).toEqual({ count: 0 });
    } finally {
      closeDb(db);
    }
  });

  it("rejects an invalid dependency clock before expiry logic can be bypassed", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const persistence = createCfpPersistence({ clock: () => "not-a-clock" });
      const before = revisionTruthSnapshot(db, data.submission.id);
      expect(() => persistence.saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_WRITE_FAILED" }));
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it("rejects direct duplicate, regression, skip, null-reset, and cross-submission pointer movement", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const applicantContext = { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId };
      const first = saveDraftRevision(db, {
        ...applicantContext,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      const second = saveDraftRevision(db, applicantContext, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: first.revisionId,
      });
      const otherApplicant = insertApplicantFixture(db, data.organizer.workspaceId, data.call.id, "other");
      const otherSubmission = createDraftSubmission(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: otherApplicant.sessionId,
      }, { callId: data.call.id });
      const otherFirst = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: otherApplicant.sessionId,
      }, {
        submissionId: otherSubmission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      const forcePointer = (revisionId: string | null): void => {
        db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
        db.prepare("UPDATE submissions SET current_revision_id = ? WHERE id = ?").run(revisionId, data.submission.id);
        db.exec(DDL);
      };
      const wrongPinnedForm = sealFormVersion(db, data.organizer, {
        formDefinitionId: data.form.formDefinitionId,
        fields: [
          { id: "trigger", type: "shortText", label: "Trigger v2", required: false, defaultVisibility: "visible" },
          { id: "consent", type: "consent", label: "Consent v2", required: false, defaultVisibility: "visible" },
        ],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      expect(() => db.prepare("UPDATE submissions SET pinned_form_version_id = ? WHERE id = ?").run(
        wrongPinnedForm.id,
        data.submission.id,
      )).toThrow(/submissions current pointer mismatch/);
      const acme = db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { id: string };
      expect(() => db.prepare("UPDATE submissions SET workspace_id = ? WHERE id = ?").run(
        acme.id,
        data.submission.id,
      )).toThrow(/submissions current pointer mismatch/);
      expect(() => db.prepare("UPDATE submissions SET current_revision_id = ? WHERE id = ?").run(first.revisionId, data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      expect(() => db.prepare("UPDATE submissions SET current_revision_id = NULL WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      expect(() => db.prepare("UPDATE submissions SET current_revision_id = ? WHERE id = ?").run(otherFirst.revisionId, data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      const third = saveDraftRevision(db, applicantContext, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: second.revisionId,
      });
      forcePointer(first.revisionId);
      expect(() => db.prepare("UPDATE submissions SET current_revision_id = ? WHERE id = ?").run(third.revisionId, data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      forcePointer(second.revisionId);
      expect(db.prepare("SELECT current_revision_id FROM submissions WHERE id = ?").get(data.submission.id)).toEqual({
        current_revision_id: second.revisionId,
      });
    } finally {
      closeDb(db);
    }
  });

  it("closes the direct revision and pointer matrix without changing truth", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const context = { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId };
      const first = saveDraftRevision(db, context, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      const second = saveDraftRevision(db, context, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: first.revisionId,
      });
      const otherApplicant = insertApplicantFixture(db, data.organizer.workspaceId, data.call.id, "matrix-other");
      const otherSubmission = createDraftSubmission(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: otherApplicant.sessionId,
      }, { callId: data.call.id });
      const otherRevision = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: otherApplicant.sessionId,
      }, {
        submissionId: otherSubmission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      const wrongForm = sealFormVersion(db, data.organizer, {
        formDefinitionId: data.form.formDefinitionId,
        fields: [
          { id: "trigger", type: "shortText", label: "Trigger changed", required: false, defaultVisibility: "visible" },
          { id: "consent", type: "consent", label: "Consent changed", required: false, defaultVisibility: "visible" },
        ],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      const acme = db.prepare("SELECT id FROM workspaces WHERE slug = 'acme'").get() as { id: string };
       const duplicateInsert = () => insertCanonicalRevisionCandidate(db, second.revisionId, "duplicate-revision", 2);
       const regressionInsert = () => insertCanonicalRevisionCandidate(db, second.revisionId, "regression-revision", 1);
       const skipInsert = () => insertCanonicalRevisionCandidate(db, second.revisionId, "skipped-revision", 4);
      const expectUnchanged = (attempt: () => unknown): void => {
        const before = revisionTruthSnapshot(db, data.submission.id);
        expect(attempt).toThrow();
        expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
      };

       expectUnchanged(duplicateInsert);
       expectUnchanged(regressionInsert);
       expectUnchanged(skipInsert);
      expectUnchanged(() => db.prepare("UPDATE submissions SET current_revision_id = ? WHERE id = ?").run(
        first.revisionId,
        data.submission.id,
      ));
      expectUnchanged(() => db.prepare("UPDATE submissions SET current_revision_id = NULL WHERE id = ?").run(
        data.submission.id,
      ));
      expectUnchanged(() => db.prepare("UPDATE submissions SET current_revision_id = ? WHERE id = ?").run(
        otherRevision.revisionId,
        data.submission.id,
      ));
      expectUnchanged(() => db.prepare("UPDATE submissions SET pinned_form_version_id = ? WHERE id = ?").run(
        wrongForm.id,
        data.submission.id,
      ));
      expectUnchanged(() => db.prepare("UPDATE submissions SET pinned_rule_version_id = ? WHERE id = ?").run(
        wrongForm.ruleVersionId,
        data.submission.id,
      ));
      expectUnchanged(() => db.prepare("UPDATE submissions SET workspace_id = ? WHERE id = ?").run(
        acme.id,
        data.submission.id,
      ));
    } finally {
      closeDb(db);
    }
  });

  it("rejects null-pointer orphans and non-contiguous histories on service read and reopen", () => {
    const path = resolve(".tmp/unit", `cfp-pointer-history-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db = openDb({ path });
    let dbClosed = false;
    try {
      const data = fixture(db);
      const first = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      const second = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: first.revisionId,
      });
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db.prepare("UPDATE submissions SET current_revision_id = NULL WHERE id = ?").run(data.submission.id);
      db.exec(DDL);
      expectAllRevisionReadSeamsToRejectWithoutWrite(
        db,
        data.organizer.workspaceId,
        data.submission.id,
        second.revisionId,
        "REVISION_POINTER_INVALID",
      );
      closeDb(db);
      dbClosed = true;
      const bytesBefore1 = readFileSync(path);
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path)).toEqual(bytesBefore1);

      removeSqliteFiles(path);
      db = openDb({ path });
      dbClosed = false;
      const secondData = fixture(db, { schema: FORM_RULES_SCHEMA, rules: [] });
      const rev1 = saveDraftRevision(db, {
        workspaceId: secondData.organizer.workspaceId,
        sessionId: secondData.applicant.sessionId,
      }, {
        submissionId: secondData.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      const rev2 = saveDraftRevision(db, {
        workspaceId: secondData.organizer.workspaceId,
        sessionId: secondData.applicant.sessionId,
      }, {
        submissionId: secondData.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: rev1.revisionId,
      });
      const rev3 = saveDraftRevision(db, {
        workspaceId: secondData.organizer.workspaceId,
        sessionId: secondData.applicant.sessionId,
      }, {
        submissionId: secondData.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: rev2.revisionId,
      });
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_no_delete");
      db.prepare("DELETE FROM submission_revisions WHERE id = ?").run(rev2.revisionId);
      db.exec(DDL);
      expectAllRevisionReadSeamsToRejectWithoutWrite(
        db,
        secondData.organizer.workspaceId,
        secondData.submission.id,
        rev3.revisionId,
        "REVISION_POINTER_INVALID",
      );
      closeDb(db);
      dbClosed = true;
      const bytesBefore2 = readFileSync(path);
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path)).toEqual(bytesBefore2);
      expect(rev3.revisionId).toBeTruthy();
    } finally {
      if (!dbClosed) {
        closeDb(db);
      }
      removeSqliteFiles(path);
    }
  }, 30000);

  it("rejects a valid revision 3 hidden behind a forced revision 2 pointer at every seam", () => {
    const path = resolve(".tmp/unit", `cfp-revision-three-pointer-two-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db | null = null;
    try {
      db = openDb({ path });
      const data = fixture(db);
      const context = { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId };
      const first = saveDraftRevision(db, context, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      const second = saveDraftRevision(db, context, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: first.revisionId,
      });
      const third = saveDraftRevision(db, context, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: second.revisionId,
      });
      db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db.prepare("UPDATE submissions SET current_revision_id = ? WHERE id = ?").run(
        second.revisionId,
        data.submission.id,
      );
      db.exec(DDL);
      const before = revisionTruthSnapshot(db, data.submission.id);
      expect(() => saveDraftRevision(db!, context, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: second.revisionId,
      })).toThrowError(expect.objectContaining({ code: "REVISION_POINTER_INVALID" }));
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
      expect(() => readSubmissionRevision(db!, data.organizer.workspaceId, third.revisionId)).toThrowError(
        expect.objectContaining({ code: "REVISION_POINTER_INVALID" }),
      );
      expect(() => readSubmissionRevisionDocument(db!, data.organizer.workspaceId, third.revisionId)).toThrowError(
        expect.objectContaining({ code: "REVISION_POINTER_INVALID" }),
      );
      expect(() => readCurrentSubmissionRevision(db!, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "REVISION_POINTER_INVALID" }),
      );
      expect(() => readCurrentSubmissionDocument(db!, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "REVISION_POINTER_INVALID" }),
      );
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
      expect(third.revision.revisionNumber).toBe(3);
      closeDb(db);
      db = null;
      const beforeReopen = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
    } finally {
      if (db) closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it("maps overlong stored revision IDs and rejects overlong caller expectations without writing", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const first = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      const second = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: first.revisionId,
      });
      const overlongRevisionId = "stored-pointer-" + "x".repeat(120);
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db.prepare("UPDATE submissions SET current_revision_id = ? WHERE id = ?").run(
        overlongRevisionId,
        data.submission.id,
      );
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(DDL);
      expectAllRevisionReadSeamsToRejectWithoutWrite(
        db,
        data.organizer.workspaceId,
        data.submission.id,
        second.revisionId,
        "REVISION_POINTER_INVALID",
      );
    } finally {
      closeDb(db);
    }

    const callerDb = openDb({ path: ":memory:" });
    try {
      const data = fixture(callerDb);
      const before = revisionTruthSnapshot(callerDb, data.submission.id);
      expect(() => saveDraftRevision(callerDb, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: "caller-revision-" + "y".repeat(120),
      })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_INPUT_INVALID" }));
      expect(revisionTruthSnapshot(callerDb, data.submission.id)).toEqual(before);
    } finally {
      closeDb(callerDb);
    }
  });

  it("rejects a forcibly cross-submission current pointer across all four public seams with complete no-write truth comparison", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const applicantContext = { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId };
      const first = saveDraftRevision(db, applicantContext, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      const second = saveDraftRevision(db, applicantContext, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: first.revisionId,
      });
      const otherApplicant = insertApplicantFixture(db, data.organizer.workspaceId, data.call.id, "forcibly-cross-sub");
      const otherSubmission = createDraftSubmission(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: otherApplicant.sessionId,
      }, { callId: data.call.id });
      const otherRevision = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: otherApplicant.sessionId,
      }, {
        submissionId: otherSubmission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });

      db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db.prepare("UPDATE submissions SET current_revision_id = ? WHERE id = ?").run(
        otherRevision.revisionId,
        data.submission.id,
      );
      db.exec(DDL);

      expectAllRevisionReadSeamsToRejectWithoutWrite(
        db,
        data.organizer.workspaceId,
        data.submission.id,
        second.revisionId,
        "REVISION_POINTER_INVALID",
      );
    } finally {
      closeDb(db);
    }
  });

  it("maps stored revision corruption without leaking driver or hostile content", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(
        db,
        { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId },
        {
          submissionId: data.submission.id,
          historicalAnswers: [{ fieldId: "consent", value: true }],
          expectedCurrentRevisionId: null,
        },
      );
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ? WHERE id = ?").run(
        "{\"SENTINEL_SECRET\":true}",
        saved.revisionId,
      );
      expect(() => readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      try {
        readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id);
      } catch (error) {
        expect(error).toBeInstanceOf(FormDocumentPersistenceError);
        expect((error as Error).message).not.toContain("SENTINEL");
        expect((error as Error).message).not.toContain("SQLite");
      }
    } finally {
      closeDb(db);
    }
  });

  it("rejects recomputed outer fingerprints when E1 answers or receipt values are tampered", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const stored = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const parsed = JSON.parse(stored.revision_json) as typeof saved.revision;
      const { fingerprint: _originalFormFingerprint, ...formWithoutFingerprint } = parsed.formDocument;
      const alteredForm = normalizeFormDocument({
        ...formWithoutFingerprint,
        effectiveAnswers: [],
      });
      const alteredContent = {
        ...parsed,
        formDocument: alteredForm,
        fingerprint: undefined,
      } as Record<string, unknown>;
      delete alteredContent.fingerprint;
      const altered = {
        ...alteredContent,
        fingerprint: fingerprintOf(alteredContent),
      };
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare(
        `UPDATE submission_revisions
         SET revision_json = ?, form_document_fingerprint = ?, fingerprint = ?
         WHERE id = ?`,
      ).run(canonicalJson(altered), alteredForm.fingerprint, altered.fingerprint, saved.revisionId);
      db.exec(DDL);
      expect(() => readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );

      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, form_document_fingerprint = ?, fingerprint = ? WHERE id = ?")
        .run(stored.revision_json, saved.revision.formDocument.fingerprint, saved.revision.fingerprint, saved.revisionId);
      db.exec(DDL);
      const receiptTampered = JSON.parse(stored.revision_json) as typeof saved.revision;
      if (!receiptTampered.consentReceipt) throw new Error("expected receipt fixture");
      const falseReceipt = {
        ...receiptTampered.consentReceipt,
        choices: [{ fieldId: "consent", value: false }],
      };
      const receiptContent = {
        ...receiptTampered,
        consentReceipt: falseReceipt,
        fingerprint: undefined,
      } as Record<string, unknown>;
      delete receiptContent.fingerprint;
      const receiptAltered = {
        ...receiptContent,
        fingerprint: fingerprintOf(receiptContent),
      };
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?")
        .run(canonicalJson(receiptAltered), receiptAltered.fingerprint, saved.revisionId);
      db.exec(DDL);
      expect(() => readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
    } finally {
      closeDb(db);
    }
  });

  it("rejects a column-only outer fingerprint mirror tamper on a live service read", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const before = db.prepare(
        "SELECT revision_json, fingerprint FROM submission_revisions WHERE id = ?",
      ).get(saved.revisionId);
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET fingerprint = ? WHERE id = ?").run(
        "0".repeat(64),
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readSubmissionRevision(db, data.organizer.workspaceId, saved.revisionId)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_MIRROR_MISMATCH" }),
      );
      expect(db.prepare(
        "SELECT revision_json, fingerprint FROM submission_revisions WHERE id = ?",
      ).get(saved.revisionId)).toEqual({
        revision_json: (before as { revision_json: string }).revision_json,
        fingerprint: "0".repeat(64),
      });
    } finally {
      closeDb(db);
    }
  });

  it("rejects noncanonical outer revision bytes even when the stored row fingerprint is unchanged", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const stored = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ? WHERE id = ?").run(
        ` ${stored.revision_json} `,
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readSubmissionRevision(db, data.organizer.workspaceId, saved.revisionId)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_NOT_CANONICAL" }),
      );
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["schema", (content: Record<string, unknown>) => ({ ...content, schema: "forged-outer-schema" })],
    ["fingerprint algorithm", (content: Record<string, unknown>) => ({ ...content, fingerprintAlgorithm: "forged-outer-algorithm" })],
  ] as const)("rejects top-level outer %s tampering without a write", (_name, mutate) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const content = mutate(JSON.parse(row.revision_json) as Record<string, unknown>) as Record<string, unknown>;
      delete content.fingerprint;
      const altered = { ...content, fingerprint: fingerprintOf(content) };
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(altered),
        altered.fingerprint,
        saved.revisionId,
      );
      db.exec(DDL);
      const before = revisionTruthSnapshot(db, data.submission.id);
      expect(() => readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["submission", (receipt: Record<string, unknown>) => ({ ...receipt, submissionId: "forged-submission" })],
    ["person", (receipt: Record<string, unknown>) => ({ ...receipt, personId: "forged-person" })],
    ["session", (receipt: Record<string, unknown>) => ({ ...receipt, applicantSessionId: "forged-session" })],
    ["receivedAt", (receipt: Record<string, unknown>) => ({
      ...receipt,
      receivedAt: new Date(Date.parse(String(receipt.receivedAt)) + 1_000).toISOString(),
    })],
    ["policy fingerprint", (receipt: Record<string, unknown>) => ({
      ...receipt,
      policyFingerprint: "0".repeat(64),
    })],
    ["choices", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [{ fieldId: "consent", value: false }],
    })],
  ] as const)("rejects recomputed %s receipt tampering", (_name, mutate) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const parsed = JSON.parse(row.revision_json) as Record<string, unknown>;
      const originalReceipt = parsed.consentReceipt as Record<string, unknown>;
       const content: Record<string, unknown> = {
         ...parsed,
         consentReceipt: mutate(originalReceipt),
       };
       delete content.fingerprint;
       const altered = { ...content, fingerprint: fingerprintOf(content) as string } as Record<string, unknown>;
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(altered),
         altered.fingerprint as string,
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readSubmissionRevision(db, data.organizer.workspaceId, saved.revisionId)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["submission identity", (receipt: Record<string, unknown>) => ({ ...receipt, submissionId: "wrong-submission" })],
    ["person identity", (receipt: Record<string, unknown>) => ({ ...receipt, personId: "wrong-person" })],
    ["session identity", (receipt: Record<string, unknown>) => ({ ...receipt, applicantSessionId: "wrong-session" })],
    ["receipt time", (receipt: Record<string, unknown>) => ({
      ...receipt,
      receivedAt: "2090-08-10T00:00:00.000Z",
    })],
    ["policy fingerprint", (receipt: Record<string, unknown>) => ({
      ...receipt,
      policyFingerprint: "0".repeat(64),
    })],
    ["object choices", (receipt: Record<string, unknown>) => ({ ...receipt, choices: {} })],
    ["missing choice", (receipt: Record<string, unknown>) => ({ ...receipt, choices: [] })],
    ["duplicate choice", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [
        { fieldId: "consent", value: true },
        { fieldId: "consent", value: true },
      ],
    })],
    ["unknown choice", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [{ fieldId: "unknown", value: true }],
    })],
    ["string boolean", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [{ fieldId: "consent", value: "true" }],
    })],
    ["extra receipt key", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [{ fieldId: "consent", value: true, extra: true }],
    })],
  ] as const)("rejects %s at the revision INSERT seam", (_name, mutate) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const source = db.prepare("SELECT * FROM submission_revisions WHERE id = ?").get(saved.revisionId) as Record<string, unknown>;
      const parsed = JSON.parse(String(source.revision_json)) as Record<string, unknown>;
      const originalReceipt = parsed.consentReceipt as Record<string, unknown>;
       const content: Record<string, unknown> = {
         ...parsed,
         consentReceipt: mutate(originalReceipt),
       };
       delete content.fingerprint;
       const altered = { ...content, fingerprint: fingerprintOf(content) as string } as Record<string, unknown>;

      db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_no_delete");
      db.prepare("UPDATE submissions SET current_revision_id = NULL WHERE id = ?").run(data.submission.id);
      db.prepare("DELETE FROM submission_revisions WHERE id = ?").run(saved.revisionId);
      db.exec(DDL);

      expect(() => insertRevisionRowWithJson(
        db,
        source,
        `malformed-receipt-${_name.replaceAll(" ", "-")}`,
        canonicalJson(altered),
        altered.fingerprint as string,
      )).toThrow(/submission_revisions workspace mismatch/);
      expect(db.prepare("SELECT current_revision_id FROM submissions WHERE id = ?").get(data.submission.id)).toEqual({
        current_revision_id: null,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM submission_revisions").get()).toEqual({ count: 0 });
    } finally {
      closeDb(db);
    }
  });

  const orderedReceiptMutations = [
    ["identity", (receipt: Record<string, unknown>) => ({ ...receipt, submissionId: "wrong-submission" })],
    ["person", (receipt: Record<string, unknown>) => ({ ...receipt, personId: "wrong-person" })],
    ["session", (receipt: Record<string, unknown>) => ({ ...receipt, applicantSessionId: "wrong-session" })],
    ["time", (receipt: Record<string, unknown>) => ({ ...receipt, receivedAt: "2090-08-10T00:00:00.000Z" })],
    ["policy binding", (receipt: Record<string, unknown>) => ({ ...receipt, policyFingerprint: "0".repeat(64) })],
    ["array/object shape", (receipt: Record<string, unknown>) => ({ ...receipt, choices: {} })],
    ["missing", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [
        { fieldId: "secondConsent", value: true },
      ],
    })],
    ["duplicate", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [
        { fieldId: "secondConsent", value: true },
        { fieldId: "secondConsent", value: false },
      ],
    })],
    ["unknown", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [
        { fieldId: "unknown", value: true },
        { fieldId: "firstConsent", value: false },
      ],
    })],
    ["reordered", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [
        { fieldId: "firstConsent", value: false },
        { fieldId: "secondConsent", value: true },
      ],
    })],
    ["non-boolean", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [
        { fieldId: "secondConsent", value: "true" },
        { fieldId: "firstConsent", value: false },
      ],
    })],
    ["extra-key", (receipt: Record<string, unknown>) => ({
      ...receipt,
      choices: [
        { fieldId: "secondConsent", value: true, extra: true },
        { fieldId: "firstConsent", value: false },
      ],
    })],
  ] as const;

  it.each(orderedReceiptMutations)("rejects ordered two-choice %s at the revision INSERT seam", (_name, mutate) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = orderedReceiptFixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [
          { fieldId: "firstConsent", value: false },
          { fieldId: "secondConsent", value: true },
        ],
        expectedCurrentRevisionId: null,
      });
      const source = db.prepare("SELECT * FROM submission_revisions WHERE id = ?").get(saved.revisionId) as Record<string, unknown>;
      const parsed = JSON.parse(String(source.revision_json)) as Record<string, unknown>;
      const content: Record<string, unknown> = {
        ...parsed,
        consentReceipt: mutate(parsed.consentReceipt as Record<string, unknown>),
      };
      delete content.fingerprint;
      const altered = { ...content, fingerprint: fingerprintOf(content) };
      db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_no_delete");
      db.prepare("UPDATE submissions SET current_revision_id = NULL WHERE id = ?").run(data.submission.id);
      db.prepare("DELETE FROM submission_revisions WHERE id = ?").run(saved.revisionId);
      db.exec(DDL);
      expect(() => insertRevisionRowWithJson(
        db,
        source,
        `ordered-malformed-${_name.replaceAll(" ", "-")}`,
        canonicalJson(altered),
        altered.fingerprint,
      )).toThrow(/submission_revisions workspace mismatch/);
      expect(revisionTruthSnapshot(db, data.submission.id).revisions).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  it.each(orderedReceiptMutations)("rejects ordered two-choice %s at live read, direct SUBMITTED, and V3 reopen", (_name, mutate) => {
    const path = resolve(".tmp/unit", `cfp-ordered-receipt-${_name.replaceAll(" ", "-")}-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db | null = null;
    try {
      db = openDb({ path });
      const data = orderedReceiptFixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [
          { fieldId: "firstConsent", value: false },
          { fieldId: "secondConsent", value: true },
        ],
        expectedCurrentRevisionId: null,
      });
      const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const parsed = JSON.parse(row.revision_json) as Record<string, unknown>;
      const content: Record<string, unknown> = {
        ...parsed,
        consentReceipt: mutate(parsed.consentReceipt as Record<string, unknown>),
      };
      delete content.fingerprint;
      const altered = { ...content, fingerprint: fingerprintOf(content) };
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(altered),
        altered.fingerprint,
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readCurrentSubmissionRevision(db!, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      expect(() => db!.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      closeDb(db);
      db = null;
      const beforeReopen = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
    } finally {
      if (db) closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it("rejects a zero-choice object receipt at live read, direct SUBMITTED, and V3 reopen seams", () => {
    const path = resolve(".tmp/unit", `cfp-zero-choice-receipt-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db | null = null;
    try {
      db = openDb({ path });
      const data = fixture(db);
      const current = readCall(db, data.organizer.workspaceId, data.call.id);
      updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: current.fingerprint,
        policy: { disclosure: current.disclosure, choices: [] },
      });
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      expect(saved.revision.consentReceipt?.choices).toEqual([]);
      const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const parsed = JSON.parse(row.revision_json) as Record<string, unknown>;
      const originalReceipt = parsed.consentReceipt as Record<string, unknown>;
       const content: Record<string, unknown> = {
         ...parsed,
         consentReceipt: { ...originalReceipt, choices: {} },
       };
       delete content.fingerprint;
       const altered = { ...content, fingerprint: fingerprintOf(content) as string } as Record<string, unknown>;
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(altered),
         altered.fingerprint as string,
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readCurrentSubmissionRevision(db!, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      expect(() => db!.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      closeDb(db);
      db = null;
      const beforeReopen = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
    } finally {
      if (db) closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it.each(["policy", "receipt"] as const)(
    "rejects a stringified %s choice at revision INSERT after the array seam succeeds",
    (target) => {
      const db = openDb({ path: ":memory:" });
      try {
        const data = orderedReceiptFixture(db);
        const saved = saveDraftRevision(db, {
          workspaceId: data.organizer.workspaceId,
          sessionId: data.applicant.sessionId,
        }, {
          submissionId: data.submission.id,
          historicalAnswers: [
            { fieldId: "firstConsent", value: false },
            { fieldId: "secondConsent", value: true },
          ],
          expectedCurrentRevisionId: null,
        });
        const source = db.prepare("SELECT * FROM submission_revisions WHERE id = ?").get(saved.revisionId) as Record<string, unknown>;
        const parsed = JSON.parse(String(source.revision_json)) as Record<string, unknown>;
        const key = target === "policy" ? "callPolicy" : "consentReceipt";
        const original = parsed[key] as Record<string, unknown>;
        const choices = original.choices as unknown[];
        const alteredPart = { ...original, choices: [JSON.stringify(choices[0])] };
        const content: Record<string, unknown> = { ...parsed, [key]: alteredPart };
        delete content.fingerprint;
        const altered = { ...content, fingerprint: fingerprintOf(content) };

        expect(db.prepare("SELECT json_type(?, '$.callPolicy.choices') AS policyType, json_type(?, '$.consentReceipt.choices') AS receiptType")
          .get(canonicalJson(altered), canonicalJson(altered))).toEqual({ policyType: "array", receiptType: "array" });
        expect(db.prepare("SELECT type FROM json_each(?, '$." + key + ".choices')").all(canonicalJson(altered))).toEqual([
          { type: "text" },
        ]);

        db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
        db.exec("DROP TRIGGER trg_cfp_submission_revisions_no_delete");
        db.prepare("UPDATE submissions SET current_revision_id = NULL WHERE id = ?").run(data.submission.id);
        db.prepare("DELETE FROM submission_revisions WHERE id = ?").run(saved.revisionId);
        db.exec(DDL);
        const beforeInsert = revisionTruthSnapshot(db, data.submission.id);
        expect(() => insertRevisionRowWithJson(
          db,
          source,
          `stringified-${target}-choice`,
          canonicalJson(altered),
          altered.fingerprint,
        )).toThrow(/submission_revisions workspace mismatch/);
        expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforeInsert);
      } finally {
        closeDb(db);
      }
    },
  );

  it.each(["policy", "receipt"] as const)(
    "rejects a stringified %s choice at live read, direct SUBMITTED, and no-change V3 reopen",
    (target) => {
      const path = resolve(".tmp/unit", `cfp-stringified-${target}-${process.pid}.db`);
      removeSqliteFiles(path);
      let db: Db | null = null;
      try {
        db = openDb({ path });
        const data = orderedReceiptFixture(db);
        const saved = saveDraftRevision(db, {
          workspaceId: data.organizer.workspaceId,
          sessionId: data.applicant.sessionId,
        }, {
          submissionId: data.submission.id,
          historicalAnswers: [
            { fieldId: "firstConsent", value: false },
            { fieldId: "secondConsent", value: true },
          ],
          expectedCurrentRevisionId: null,
        });
        const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
          revision_json: string;
        };
        const parsed = JSON.parse(row.revision_json) as Record<string, unknown>;
        const key = target === "policy" ? "callPolicy" : "consentReceipt";
        const original = parsed[key] as Record<string, unknown>;
        const choices = original.choices as unknown[];
        const alteredPart = { ...original, choices: [JSON.stringify(choices[0]), ...choices.slice(1)] };
        const content: Record<string, unknown> = { ...parsed, [key]: alteredPart };
        delete content.fingerprint;
        const altered = { ...content, fingerprint: fingerprintOf(content) };
        expect(db.prepare("SELECT json_type(?, '$.callPolicy.choices') AS policyType, json_type(?, '$.consentReceipt.choices') AS receiptType")
          .get(canonicalJson(altered), canonicalJson(altered))).toEqual({ policyType: "array", receiptType: "array" });
        expect(db.prepare("SELECT type FROM json_each(?, '$." + key + ".choices') LIMIT 1").get(canonicalJson(altered))).toEqual({ type: "text" });
        db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
        db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
          canonicalJson(altered),
          altered.fingerprint,
          saved.revisionId,
        );
        db.exec(DDL);
        expect(() => readCurrentSubmissionRevision(db!, data.organizer.workspaceId, data.submission.id)).toThrowError(
          expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
        );
        expect(() => db!.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
          /submissions current pointer mismatch/,
        );
        closeDb(db);
        db = null;
        const beforeReopen = readFileSync(path).toString("base64");
        expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
        expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
      } finally {
        if (db) closeDb(db);
        removeSqliteFiles(path);
      }
    },
  );

  it("rejects a stringified empty receipt array while the valid policy array remains an array", () => {
    const path = resolve(".tmp/unit", `cfp-stringified-empty-receipt-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db | null = null;
    try {
      db = openDb({ path });
      const data = fixture(db);
      const current = readCall(db, data.organizer.workspaceId, data.call.id);
      updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: current.fingerprint,
        policy: { disclosure: current.disclosure, choices: [] },
      });
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const parsed = JSON.parse(row.revision_json) as Record<string, unknown>;
      const receipt = parsed.consentReceipt as Record<string, unknown>;
      const content: Record<string, unknown> = {
        ...parsed,
        consentReceipt: { ...receipt, choices: "[]" },
      };
      delete content.fingerprint;
      const altered = { ...content, fingerprint: fingerprintOf(content) };
      expect(db.prepare("SELECT json_type(?, '$.callPolicy.choices') AS policyType, json_type(?, '$.consentReceipt.choices') AS receiptType")
        .get(canonicalJson(altered), canonicalJson(altered))).toEqual({ policyType: "array", receiptType: "text" });
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(altered),
        altered.fingerprint,
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readCurrentSubmissionRevision(db!, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      expect(() => db!.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      closeDb(db);
      db = null;
      const beforeReopen = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
    } finally {
      if (db) closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it("rejects a stringified current call-policy choice at revision INSERT, direct SUBMITTED, and V3 reopen seams", () => {
    const path = resolve(".tmp/unit", `cfp-stringified-current-policy-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db | null = null;
    try {
      db = openDb({ path });
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const callRow = db.prepare("SELECT policy_json FROM calls WHERE id = ?").get(data.call.id) as {
        policy_json: string;
      };
      const callPolicy = JSON.parse(callRow.policy_json) as Record<string, unknown>;
      const choice = (callPolicy.choices as unknown[])[0];
      const alteredPolicy = {
        ...callPolicy,
        choices: [JSON.stringify(choice)],
      };
      expect(db.prepare("SELECT json_type(?, '$.choices') AS arrayType").get(canonicalJson(alteredPolicy))).toEqual({ arrayType: "array" });
      expect(db.prepare("SELECT type FROM json_each(?, '$.choices')").get(canonicalJson(alteredPolicy))).toEqual({ type: "text" });
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET policy_json = ? WHERE id = ?").run(canonicalJson(alteredPolicy), data.call.id);
      db.exec(DDL);
      const beforeInsert = revisionTruthSnapshot(db, data.submission.id);
      expect(() => insertCanonicalRevisionCandidate(db!, saved.revisionId, "stringified-current-policy-revision", 2)).toThrow(
        /submission_revisions workspace mismatch/,
      );
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforeInsert);
      expect(() => db!.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      closeDb(db);
      db = null;
      const beforeReopen = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
    } finally {
      if (db) closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["missing required", (choice: Record<string, unknown>) => {
      const { required: _required, ...withoutRequired } = choice;
      return withoutRequired;
    }],
    ["non-boolean required", (choice: Record<string, unknown>) => ({ ...choice, required: "true" })],
    ["extra policy key", (choice: Record<string, unknown>) => ({ ...choice, extra: true })],
  ] as const)("rejects a retained policy choice with %s at live read, direct SUBMITTED, and V3 reopen", (_name, mutate) => {
    const path = resolve(".tmp/unit", `cfp-retained-policy-shape-${_name.replaceAll(" ", "-")}-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db | null = null;
    try {
      db = openDb({ path });
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const parsed = JSON.parse(row.revision_json) as Record<string, unknown>;
      const originalPolicy = parsed.callPolicy as Record<string, unknown>;
      const originalChoices = originalPolicy.choices as Array<Record<string, unknown>>;
      const alteredPolicy = {
        ...originalPolicy,
        choices: [mutate(originalChoices[0]!)],
      };
      const content: Record<string, unknown> = {
        ...parsed,
        callPolicy: alteredPolicy,
      };
      delete content.fingerprint;
      const altered = { ...content, fingerprint: fingerprintOf(content) };
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(altered),
        altered.fingerprint,
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readCurrentSubmissionRevision(db!, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      expect(() => db!.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      db!.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db!.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id);
      db!.exec(DDL);
      expect(db!.prepare("SELECT state FROM submissions WHERE id = ?").get(data.submission.id)).toEqual({ state: "SUBMITTED" });
      closeDb(db);
      db = null;
      const beforeReopen = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
    } finally {
      if (db) closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it("rejects a raw duplicate-key retained policy choice whose count hides missing required", () => {
    const path = resolve(".tmp/unit", `cfp-duplicate-required-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db | null = null;
    try {
      db = openDb({ path });
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const parsed = JSON.parse(row.revision_json) as Record<string, unknown>;
      const policy = parsed.callPolicy as Record<string, unknown>;
      const choice = (policy.choices as Array<Record<string, unknown>>)[0]!;
      const duplicateChoice = `{"fieldId":${JSON.stringify(choice.fieldId)},"fieldId":${JSON.stringify(choice.fieldId)},"statement":${JSON.stringify(choice.statement)}}`;
      const raw = row.revision_json.replace(canonicalJson(choice), duplicateChoice);
      expect(raw).not.toBe(row.revision_json);
      expect(db.prepare("SELECT json_type(?, '$.callPolicy.choices') AS arrayType").get(raw)).toEqual({ arrayType: "array" });
      expect(db.prepare("SELECT choice.type, (SELECT COUNT(*) FROM json_each(choice.value)) AS memberCount, json_type(choice.value, '$.required') AS requiredType FROM json_each(?, '$.callPolicy.choices') choice")
        .get(raw)).toEqual({ type: "object", memberCount: 3, requiredType: null });
      const logical = JSON.parse(raw) as Record<string, unknown>;
      delete logical.fingerprint;
      const outerFingerprint = fingerprintOf(logical);
      const rawWithFingerprint = raw.replace(
        `"fingerprint":${JSON.stringify(parsed.fingerprint)}`,
        `"fingerprint":${JSON.stringify(outerFingerprint)}`,
      );
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        rawWithFingerprint,
        outerFingerprint,
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readCurrentSubmissionRevision(db!, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      expect(() => db!.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      db!.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db!.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id);
      db!.exec(DDL);
      expect(db!.prepare("SELECT state FROM submissions WHERE id = ?").get(data.submission.id)).toEqual({ state: "SUBMITTED" });
      closeDb(db);
      db = null;
      const beforeReopen = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
    } finally {
      if (db) closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["nested schema", (policy: Record<string, unknown>) => ({ ...policy, schema: "forged-policy-schema" })],
    ["nested algorithm", (policy: Record<string, unknown>) => ({ ...policy, fingerprintAlgorithm: "forged-algorithm" })],
    ["nested fingerprint", (policy: Record<string, unknown>) => ({ ...policy, fingerprint: "0".repeat(64) })],
    ["nested disclosure shape", (policy: Record<string, unknown>) => ({
      ...policy,
      disclosure: { ...(policy.disclosure as Record<string, unknown>), extra: true },
    })],
    ["nested depth", (policy: Record<string, unknown>) => ({
      ...policy,
      disclosure: {
        ...(policy.disclosure as Record<string, unknown>),
        privacy: nestedValue(30),
      },
    })],
  ] as const)("rejects %s tampering at live read and no-change V3 reopen", (_name, mutate) => {
    const path = resolve(".tmp/unit", `cfp-nested-policy-${_name.replaceAll(" ", "-")}-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db | null = null;
    try {
      db = openDb({ path });
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const stored = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const parsed = JSON.parse(stored.revision_json) as Record<string, unknown>;
      const content: Record<string, unknown> = {
        ...parsed,
        callPolicy: mutate(parsed.callPolicy as Record<string, unknown>),
      };
      delete content.fingerprint;
      const altered = { ...content, fingerprint: fingerprintOf(content) };
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(altered),
        altered.fingerprint,
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readCurrentSubmissionRevision(db!, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      closeDb(db);
      db = null;
      const beforeReopen = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed|structural depth/);
      expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
    } finally {
      if (db) closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it.each([
    ["submission identity", (receipt: Record<string, unknown>) => ({ ...receipt, submissionId: "wrong-submission" })],
    ["person identity", (receipt: Record<string, unknown>) => ({ ...receipt, personId: "wrong-person" })],
    ["session identity", (receipt: Record<string, unknown>) => ({ ...receipt, applicantSessionId: "wrong-session" })],
    ["receipt time", (receipt: Record<string, unknown>) => ({ ...receipt, receivedAt: "2090-08-10T00:00:00.000Z" })],
    ["policy fingerprint", (receipt: Record<string, unknown>) => ({ ...receipt, policyFingerprint: "0".repeat(64) })],
  ] as const)("rejects %s at live read and direct SUBMITTED guard", (_name, mutate) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const parsed = JSON.parse(row.revision_json) as Record<string, unknown>;
      const content: Record<string, unknown> = {
        ...parsed,
        consentReceipt: mutate(parsed.consentReceipt as Record<string, unknown>),
      };
      delete content.fingerprint;
      const altered = { ...content, fingerprint: fingerprintOf(content) as string };
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(altered),
        altered.fingerprint,
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      expect(() => db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["rule noncanonical bytes", "rule", "RULE_ARTIFACT_NOT_CANONICAL"],
    ["rule fingerprint mirror", "rule-fingerprint", "RULE_ARTIFACT_NOT_CANONICAL"],
    ["form noncanonical bytes", "form", "FORM_ARTIFACT_NOT_CANONICAL"],
    ["policy payload", "policy", "CALL_POLICY_INVALID"],
  ] as const)("rejects stored %s", (_name, tamper, code) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      if (tamper === "rule" || tamper === "rule-fingerprint") {
        const row = db.prepare("SELECT rules_json FROM rule_versions WHERE id = ?").get(data.form.ruleVersionId) as {
          rules_json: string;
        };
        const fingerprintRow = db.prepare("SELECT fingerprint FROM rule_versions WHERE id = ?").get(data.form.ruleVersionId) as {
          fingerprint: string;
        };
        db.exec("DROP TRIGGER trg_cfp_rule_versions_immutable");
        db.prepare("UPDATE rule_versions SET rules_json = ?, fingerprint = ? WHERE id = ?").run(
          tamper === "rule" ? ` ${row.rules_json} ` : row.rules_json,
          tamper === "rule-fingerprint" ? "0".repeat(64) : fingerprintRow.fingerprint,
          data.form.ruleVersionId,
        );
        db.exec(DDL);
        expect(() => readRuleVersion(db, data.organizer.workspaceId, data.form.ruleVersionId)).toThrowError(
          expect.objectContaining({ code }),
        );
      } else if (tamper === "form") {
        const row = db.prepare("SELECT document_json FROM form_versions WHERE id = ?").get(data.form.id) as {
          document_json: string;
        };
        db.exec("DROP TRIGGER trg_cfp_form_versions_immutable");
        db.prepare("UPDATE form_versions SET document_json = ? WHERE id = ?").run(` ${row.document_json} `, data.form.id);
        db.exec(DDL);
        expect(() => readFormVersionDocument(db, data.organizer.workspaceId, data.form.id)).toThrowError(
          expect.objectContaining({ code }),
        );
      } else {
        db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
        db.prepare("UPDATE calls SET policy_json = ? WHERE id = ?").run("{}", data.call.id);
        db.exec(DDL);
        expect(() => readCall(db, data.organizer.workspaceId, data.call.id)).toThrowError(
          expect.objectContaining({ code }),
        );
      }
    } finally {
      closeDb(db);
    }
  });

  it.each([
    ["nonempty answers", "nonempty", "FORM_ARTIFACT_MIRROR_MISMATCH"],
    ["field/rule mismatch", "identity", "FORM_ARTIFACT_MIRROR_MISMATCH"],
    ["deep hostile JSON", "depth", "FORM_ARTIFACT_INVALID"],
    ["oversized JSON", "oversized", "FORM_ARTIFACT_INVALID"],
  ] as const)("rejects stored form %s at its intended read clause", (_name, tamper, code) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const row = db.prepare("SELECT document_json, fingerprint, rule_version_id FROM form_versions WHERE id = ?").get(data.form.id) as {
        document_json: string;
        fingerprint: string;
        rule_version_id: string;
      };
      let documentJson = row.document_json;
      let fingerprint = row.fingerprint;
      if (tamper === "nonempty" || tamper === "identity") {
        const parsed = JSON.parse(row.document_json) as Record<string, unknown>;
        const content: Record<string, unknown> = { ...parsed };
        delete content.fingerprint;
        if (tamper === "nonempty") {
          content.historicalAnswers = [{ fieldId: "trigger", value: "stored" }];
        } else {
          content.ruleVersionId = "mismatched-rule";
        }
        const altered = normalizeFormDocument(content);
        documentJson = canonicalJson(altered);
        fingerprint = altered.fingerprint;
      } else if (tamper === "depth") {
        documentJson = "[".repeat(40) + "0" + "]".repeat(40);
      } else {
        documentJson = JSON.stringify("x".repeat(4 * 1024 * 1024 + 1));
      }
      db.exec("DROP TRIGGER trg_cfp_form_versions_immutable");
      db.prepare("UPDATE form_versions SET document_json = ?, fingerprint = ? WHERE id = ?").run(
        documentJson,
        fingerprint,
        data.form.id,
      );
      db.exec(DDL);
      expect(() => readFormVersionDocument(db, data.organizer.workspaceId, data.form.id)).toThrowError(
        expect.objectContaining({ code }),
      );
      expect(row.rule_version_id).toBe(data.form.ruleVersionId);
    } finally {
      closeDb(db);
    }
  });

  it("keeps old draft pins readable across form and policy rollover after SQLite reopen", () => {
    const path = resolve(".tmp/unit", `cfp-rollover-reopen-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db = openDb({ path });
    try {
      const data = fixture(db);
      const formV2 = sealFormVersion(db, data.organizer, {
        formDefinitionId: data.form.formDefinitionId,
        fields: [
          { id: "trigger", type: "shortText", label: "Trigger", required: false, defaultVisibility: "visible" },
          { id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" },
          { id: "hiddenConsent", type: "acknowledgement", label: "Hidden consent", required: false, defaultVisibility: "hidden" },
          { id: "coSpeaker", type: "coSpeakerReference", label: "Co-speaker", required: false, defaultVisibility: "visible" },
          { id: "newField", type: "longText", label: "New field", required: false, defaultVisibility: "visible" },
        ],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      const applicantContext = { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId };
      expect(advanceCallFormVersion(db, data.organizer, {
        callId: data.call.id,
        expectedFormVersionId: data.form.id,
        nextFormVersionId: formV2.id,
      })).toEqual({ id: data.call.id });
      expect(() => advanceCallFormVersion(db, data.organizer, {
        callId: data.call.id,
        expectedFormVersionId: data.form.id,
        nextFormVersionId: formV2.id,
      })).toThrowError(expect.objectContaining({ code: "CALL_FORM_ADVANCE_STALE" }));
      expect(() => advanceCallFormVersion(db, data.organizer, {
        callId: data.call.id,
        expectedFormVersionId: formV2.id,
        nextFormVersionId: data.form.id,
      })).toThrowError(expect.objectContaining({ code: "CALL_FORM_ADVANCE_INVALID" }));
      const otherDefinition = createFormDefinition(db, data.organizer, { name: "Other definition" });
      const otherForm = sealFormVersion(db, data.organizer, {
        formDefinitionId: otherDefinition.id,
        fields: [
          { id: "consent", type: "consent", label: "Other consent", required: false, defaultVisibility: "visible" },
        ],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      expect(() => advanceCallFormVersion(db, data.organizer, {
        callId: data.call.id,
        expectedFormVersionId: formV2.id,
        nextFormVersionId: otherForm.id,
      })).toThrowError(expect.objectContaining({ code: "CALL_FORM_ADVANCE_INVALID" }));
      const oldDraft = saveDraftRevision(db, applicantContext, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      expect(oldDraft.revision.formDocument.formVersionId).toBe(data.form.id);
       const newDraft = createDraftSubmission(db, applicantContext, { callId: data.call.id });
       expect(newDraft.pinnedFormVersionId).toBe(formV2.id);
       const newDraftRevision = saveDraftRevision(db, applicantContext, {
         submissionId: newDraft.id,
         historicalAnswers: [{ fieldId: "consent", value: true }],
         expectedCurrentRevisionId: null,
       });
       expect(newDraftRevision.revision.formDocument.formVersionId).toBe(formV2.id);

      const firstPolicy = readCall(db, data.organizer.workspaceId, data.call.id);
      const updatedPolicy = updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: firstPolicy.fingerprint,
        policy: {
          disclosure: {
            privacy: "privacy-v2",
            retention: "retention-v2",
            aiProcessing: "ai-v2",
            communication: "communication-v2",
            consent: "consent-v2",
            publication: "publication-v2",
          },
          choices: [{ fieldId: "consent", statement: "Allow publication v2", required: true }],
        },
      });
      expect(updatedPolicy.fingerprint).not.toBe(firstPolicy.fingerprint);
      expect(() => updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: firstPolicy.fingerprint,
        policy: {
          disclosure: firstPolicy.disclosure,
          choices: firstPolicy.choices,
        },
      })).toThrowError(expect.objectContaining({ code: "CALL_POLICY_STALE" }));
      const second = saveDraftRevision(db, applicantContext, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: oldDraft.revisionId,
      });
      expect(second.revision.revisionNumber).toBe(2);
       expect(second.revision.formDocument.formVersionId).toBe(data.form.id);
       expect(second.revision.callPolicy.fingerprint).toBe(updatedPolicy.fingerprint);
       expect(oldDraft.revision.callPolicy.fingerprint).toBe(firstPolicy.fingerprint);
        const oldEnvelopeBeforeClose = readSubmissionRevision(db, data.organizer.workspaceId, oldDraft.revisionId);
        const newEnvelopeBeforeClose = readSubmissionRevision(db, data.organizer.workspaceId, second.revisionId);
        const v2EnvelopeBeforeClose = readSubmissionRevision(db, data.organizer.workspaceId, newDraftRevision.revisionId);
        expect(oldEnvelopeBeforeClose).toEqual(oldDraft.revision);
        expect(newEnvelopeBeforeClose).toEqual(second.revision);
        expect(v2EnvelopeBeforeClose).toEqual(newDraftRevision.revision);
        expect(v2EnvelopeBeforeClose.formDocument.formVersionId).toBe(formV2.id);
        expect(v2EnvelopeBeforeClose.callPolicy.fingerprint).toBe(firstPolicy.fingerprint);
       closeDb(db);
       db = openDb({ path, seed: false });
       expect(readFormVersionDocument(db, data.organizer.workspaceId, data.form.id).formVersionId).toBe(data.form.id);
       expect(readFormVersionDocument(db, data.organizer.workspaceId, formV2.id).formVersionId).toBe(formV2.id);
        const oldEnvelopeAfterReopen = readSubmissionRevision(db, data.organizer.workspaceId, oldDraft.revisionId);
        const newEnvelopeAfterReopen = readSubmissionRevision(db, data.organizer.workspaceId, second.revisionId);
        const v2EnvelopeAfterReopen = readSubmissionRevision(db, data.organizer.workspaceId, newDraftRevision.revisionId);
        expect(oldEnvelopeAfterReopen).toEqual(oldEnvelopeBeforeClose);
        expect(newEnvelopeAfterReopen).toEqual(newEnvelopeBeforeClose);
        expect(v2EnvelopeAfterReopen).toEqual(v2EnvelopeBeforeClose);
       expect(oldEnvelopeAfterReopen.formDocument.formVersionId).toBe(data.form.id);
       expect(oldEnvelopeAfterReopen.callPolicy.fingerprint).toBe(firstPolicy.fingerprint);
       expect(newEnvelopeAfterReopen.formDocument.formVersionId).toBe(data.form.id);
       expect(newEnvelopeAfterReopen.callPolicy.fingerprint).toBe(updatedPolicy.fingerprint);
       expect(readSubmissionRevisionDocument(db, data.organizer.workspaceId, oldDraft.revisionId).formVersionId).toBe(data.form.id);
       expect(readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toEqual(second.revision);
       expect(readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id).callPolicy.fingerprint).toBe(
         updatedPolicy.fingerprint,
       );
       const oldPinnedAgain = saveDraftRevision(db, applicantContext, {
         submissionId: data.submission.id,
         historicalAnswers: [{ fieldId: "consent", value: true }],
         expectedCurrentRevisionId: second.revisionId,
       });
       expect(oldPinnedAgain.revision.revisionNumber).toBe(3);
       expect(oldPinnedAgain.revision.formDocument.formVersionId).toBe(data.form.id);
       expect(oldPinnedAgain.revision.callPolicy.fingerprint).toBe(updatedPolicy.fingerprint);
       expect(readSubmissionRevision(db, data.organizer.workspaceId, oldPinnedAgain.revisionId)).toEqual(
         oldPinnedAgain.revision,
       );
    } finally {
      closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it("rejects a policy update that would strand an active draft on an older form", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const formV2 = sealFormVersion(db, data.organizer, {
        formDefinitionId: data.form.formDefinitionId,
        fields: [
          { id: "trigger", type: "shortText", label: "Trigger", required: false, defaultVisibility: "visible" },
          { id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" },
          { id: "hiddenConsent", type: "acknowledgement", label: "Hidden consent", required: false, defaultVisibility: "hidden" },
          { id: "coSpeaker", type: "coSpeakerReference", label: "Co-speaker", required: false, defaultVisibility: "visible" },
          { id: "newConsent", type: "policyAcceptance", label: "New consent", required: false, defaultVisibility: "visible" },
        ],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      advanceCallFormVersion(db, data.organizer, {
        callId: data.call.id,
        expectedFormVersionId: data.form.id,
        nextFormVersionId: formV2.id,
      });
      createDraftSubmission(
        db,
        { workspaceId: data.organizer.workspaceId, sessionId: data.applicant.sessionId },
        { callId: data.call.id },
      );
      const current = readCall(db, data.organizer.workspaceId, data.call.id);
      expect(() => updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: current.fingerprint,
        policy: {
          disclosure: current.disclosure,
          choices: [{ fieldId: "newConsent", statement: "New term", required: true }],
        },
      })).toThrowError(expect.objectContaining({ code: "CALL_POLICY_INVALID" }));
      expect(readCall(db, data.organizer.workspaceId, data.call.id).fingerprint).toBe(current.fingerprint);
    } finally {
      closeDb(db);
    }
  });

  it("rechecks the current policy against an old pinned form before saving its draft", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const formV2 = sealFormVersion(db, data.organizer, {
        formDefinitionId: data.form.formDefinitionId,
        fields: [
          { id: "trigger", type: "shortText", label: "Trigger", required: false, defaultVisibility: "visible" },
          { id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" },
          { id: "newConsent", type: "policyAcceptance", label: "New consent", required: false, defaultVisibility: "visible" },
        ],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      advanceCallFormVersion(db, data.organizer, {
        callId: data.call.id,
        expectedFormVersionId: data.form.id,
        nextFormVersionId: formV2.id,
      });
      const storedPolicy = {
        schema: CFP_CALL_POLICY_SCHEMA,
        policyVersionId: "current-only-policy",
        disclosure: {
          privacy: "privacy",
          retention: "retention",
          aiProcessing: "ai",
          communication: "communication",
          consent: "consent",
          publication: "publication",
        },
        choices: [{ fieldId: "newConsent", statement: "New term", required: true }],
      };
      const policyFingerprint = fingerprintOf(storedPolicy);
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare(
        `UPDATE calls
         SET policy_version_id = ?, policy_json = ?, policy_fingerprint = ?
         WHERE id = ?`,
      ).run(
        storedPolicy.policyVersionId,
        canonicalJson(storedPolicy),
        policyFingerprint,
        data.call.id,
      );
      db.exec(DDL);
      const before = revisionTruthSnapshot(db, data.submission.id);
      expect(() => saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      })).toThrowError(expect.objectContaining({ code: "CALL_POLICY_INVALID" }));
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it("pins literal policy bytes at 512 KiB, rejects one byte over, and advances the form", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const current = readCall(db, data.organizer.workspaceId, data.call.id);
      const policyVersionId = "boundary-policy-version";
      const full = "x".repeat(64 * 1024);
      const choices = current.choices.map((choice) => ({ ...choice, statement: "Large policy", required: true }));
      const disclosureFor = (tail: number): Record<string, unknown> => ({
        privacy: [full, full],
        retention: [full],
        aiProcessing: [full],
        communication: [full],
        consent: [full],
        publication: [full, "x".repeat(tail)],
      });
      const snapshotBytesFor = (tail: number): number => Buffer.byteLength(
        canonicalJson(policySnapshotForSize(policyVersionId, disclosureFor(tail), choices)),
        "utf8",
      );
      let low = 0;
      let high = 64 * 1024;
      let exactTail = -1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (snapshotBytesFor(middle) <= LITERAL_POLICY_LIMIT) {
          exactTail = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      expect(exactTail).toBeGreaterThanOrEqual(0);
      expect(exactTail).toBeLessThan(64 * 1024);
      expect(snapshotBytesFor(exactTail)).toBe(LITERAL_POLICY_LIMIT);

      const boundary = createCfpPersistence({ idGenerator: () => policyVersionId });
      const largePolicy = {
        disclosure: disclosureFor(exactTail),
        choices,
      };
      const updated = boundary.updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: current.fingerprint,
        policy: largePolicy,
      });
      expect(updated.fingerprint).not.toBe(current.fingerprint);
      expect(Buffer.byteLength(canonicalJson(updated), "utf8")).toBe(LITERAL_POLICY_LIMIT);
      const storedPolicy = db.prepare("SELECT policy_json FROM calls WHERE id = ?").get(data.call.id) as {
        policy_json: string;
      };
      expect(Buffer.byteLength(storedPolicy.policy_json, "utf8")).toBeGreaterThan(64 * 1024);
      expect(readCall(db, data.organizer.workspaceId, data.call.id).fingerprint).toBe(updated.fingerprint);

      const beforeOneOver = db.prepare("SELECT * FROM calls WHERE id = ?").get(data.call.id);
      expect(() => boundary.updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: updated.fingerprint,
        policy: {
          disclosure: disclosureFor(exactTail + 1),
          choices,
        },
      })).toThrowError(expect.objectContaining({ code: "CALL_POLICY_INVALID" }));
      expect(db.prepare("SELECT * FROM calls WHERE id = ?").get(data.call.id)).toEqual(beforeOneOver);

      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const savedRaw = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      expect(Buffer.byteLength(savedRaw.revision_json, "utf8")).toBeLessThan(LITERAL_OUTER_LIMIT);
      expect(Buffer.byteLength(canonicalJson(saved.revision.callPolicy), "utf8")).toBe(LITERAL_POLICY_LIMIT);

      const nextForm = sealFormVersion(db, data.organizer, {
        formDefinitionId: data.form.formDefinitionId,
        fields: [
          { id: "trigger", type: "shortText", label: "Trigger", required: false, defaultVisibility: "visible" },
          { id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" },
          { id: "hiddenConsent", type: "acknowledgement", label: "Hidden consent", required: false, defaultVisibility: "hidden" },
          { id: "coSpeaker", type: "coSpeakerReference", label: "Co-speaker", required: false, defaultVisibility: "visible" },
        ],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      expect(advanceCallFormVersion(db, data.organizer, {
        callId: data.call.id,
        expectedFormVersionId: data.form.id,
        nextFormVersionId: nextForm.id,
      })).toEqual({ id: data.call.id });
      expect(readCall(db, data.organizer.workspaceId, data.call.id).formVersionId).toBe(nextForm.id);
    } finally {
      closeDb(db);
    }
  });

  it("accepts an outer revision at literal 4 MiB and rejects one byte over without a write or on stored read/reopen", () => {
    const path = resolve(".tmp/unit", `cfp-outer-boundary-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db | null = null;
    try {
      db = openDb({ path });
      const organizer = workspaceAndAccount(db);
      db.prepare(
        `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, created_at)
         VALUES ('outer-boundary-event', ?, 'Outer boundary event', 'UTC', ?, ?, ?)`,
      ).run(
        organizer.workspaceId,
        "2026-09-15T09:00:00.000Z",
        "2026-09-15T10:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
      );
      const fields = Array.from({ length: 64 }, (_, index) => ({
        id: `hidden${String(index).padStart(2, "0")}`,
        type: "shortText" as const,
        label: `Hidden ${index}`,
        required: false,
        defaultVisibility: "hidden" as const,
      }));
      const definition = createFormDefinition(db, organizer, { name: "Outer boundary form" });
      const form = sealFormVersion(db, organizer, {
        formDefinitionId: definition.id,
        fields,
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      const call = createCall(db, organizer, {
        eventId: "outer-boundary-event",
        name: "Outer boundary call",
        slug: "outer-boundary-call",
        formVersionId: form.id,
        policy: {
          disclosure: {
            privacy: "privacy",
            retention: "retention",
            aiProcessing: "ai",
            communication: "communication",
            consent: "consent",
            publication: "publication",
          },
          choices: [],
        },
      });
      const applicant = insertApplicantFixture(db, organizer.workspaceId, call.id, "outer-boundary");
      const submission = createDraftSubmission(db, {
        workspaceId: organizer.workspaceId,
        sessionId: applicant.sessionId,
      }, { callId: call.id });
      const callPolicy = readCall(db, organizer.workspaceId, call.id).policy;
      const outerPersistence = createCfpPersistence({
        clock: () => "2090-08-10T01:00:00.000Z",
        idGenerator: () => "outer-boundary-revision",
      });
      const emptyReceipt = {
        schema: CFP_CONSENT_RECEIPT_SCHEMA,
        submissionId: submission.id,
        personId: applicant.personId,
        applicantSessionId: applicant.sessionId,
        receivedAt: "2090-08-10T01:00:00.000Z",
        policyFingerprint: callPolicy.fingerprint,
        choices: [],
      };
      const full = "x".repeat(64 * 1024);
      const answersFor = (tail: number) => fields.map((field, index) => ({
        fieldId: field.id,
        value: index === fields.length - 1 ? "x".repeat(tail) : full,
      }));
      const bytesFor = (tail: number): number => {
        try {
          return revisionEnvelopeBytes(
            submission.id,
            1,
            normalizeFormDocument({
              schema: FORM_DOCUMENT_SCHEMA,
              formVersionId: form.id,
              ruleVersionId: form.ruleVersionId,
              fields: form.document.fields,
              historicalAnswers: answersFor(tail),
              effectiveAnswers: [],
            }),
            callPolicy,
            emptyReceipt,
          );
        } catch {
          return LITERAL_OUTER_LIMIT + 1;
        }
      };
      let low = 0;
      let high = 64 * 1024;
      let exactTail = -1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (bytesFor(middle) <= LITERAL_OUTER_LIMIT) {
          exactTail = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      expect(exactTail).toBeGreaterThanOrEqual(0);
      expect(exactTail).toBeLessThan(64 * 1024);
      expect(bytesFor(exactTail)).toBe(LITERAL_OUTER_LIMIT);
      expect(bytesFor(exactTail + 1)).toBe(LITERAL_OUTER_LIMIT + 1);
      const saved = outerPersistence.saveDraftRevision(db, {
        workspaceId: organizer.workspaceId,
        sessionId: applicant.sessionId,
      }, {
        submissionId: submission.id,
        historicalAnswers: answersFor(exactTail),
        expectedCurrentRevisionId: null,
      });
      const raw = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      expect(Buffer.byteLength(raw.revision_json, "utf8")).toBe(LITERAL_OUTER_LIMIT);

      const secondSubmission = createDraftSubmission(db, {
        workspaceId: organizer.workspaceId,
        sessionId: applicant.sessionId,
      }, { callId: call.id });
      const before = revisionTruthSnapshot(db, secondSubmission.id);
      expect(() => outerPersistence.saveDraftRevision(db!, {
        workspaceId: organizer.workspaceId,
        sessionId: applicant.sessionId,
      }, {
        submissionId: secondSubmission.id,
        historicalAnswers: answersFor(exactTail + 1),
        expectedCurrentRevisionId: null,
      })).toThrowError(expect.objectContaining({ code: "SUBMISSION_REVISION_OVERSIZED" }));
      expect(revisionTruthSnapshot(db, secondSubmission.id)).toEqual(before);

      const parsedStored = JSON.parse(raw.revision_json) as Record<string, unknown>;
      const formDoc = parsedStored.formDocument as Record<string, unknown>;
      const histAnswers = formDoc.historicalAnswers as Array<Record<string, unknown>>;
      const lastAnswer = histAnswers[histAnswers.length - 1]!;
      const alteredAnswers = [
        ...histAnswers.slice(0, -1),
        { ...lastAnswer, value: String(lastAnswer.value) + "x" },
      ];
      const alteredFormDoc: Record<string, unknown> = { ...formDoc, historicalAnswers: alteredAnswers };
      delete alteredFormDoc.fingerprint;
      const recomputedFormDoc = { ...alteredFormDoc, fingerprint: fingerprintOf(alteredFormDoc) };
      const alteredEnvelopeContent: Record<string, unknown> = { ...parsedStored, formDocument: recomputedFormDoc };
      delete alteredEnvelopeContent.fingerprint;
      const alteredOuterFingerprint = fingerprintOf(alteredEnvelopeContent);
      const alteredOneOverJson = canonicalJson({
        ...alteredEnvelopeContent,
        fingerprint: alteredOuterFingerprint,
      });

      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        alteredOneOverJson,
        alteredOuterFingerprint,
        saved.revisionId,
      );
      db.exec(DDL);

      const stored = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      expect(Buffer.byteLength(stored.revision_json, "utf8")).toBe(LITERAL_OUTER_LIMIT + 1);

      const beforeRead = revisionTruthSnapshot(db, submission.id);
      expect(() => readCurrentSubmissionRevision(db!, organizer.workspaceId, submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_OVERSIZED" }),
      );
      expect(() => readSubmissionRevision(db!, organizer.workspaceId, saved.revisionId)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_OVERSIZED" }),
      );
      expect(revisionTruthSnapshot(db, submission.id)).toEqual(beforeRead);

      closeDb(db);
      db = null;
      const beforeReopen = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/malformed schema v3|tenant integrity check failed/);
      expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
    } finally {
      if (db) closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it.each(["policy", "receipt"] as const)(
    "isolates a nested %s size rejection on no-change V3 reopen while the outer envelope stays bounded",
    (target) => {
      const path = resolve(".tmp/unit", `cfp-nested-size-${target}-${process.pid}.db`);
      removeSqliteFiles(path);
      let db: Db | null = null;
      try {
        db = openDb({ path });
        const data = fixture(db);
        const saved = saveDraftRevision(db, {
          workspaceId: data.organizer.workspaceId,
          sessionId: data.applicant.sessionId,
        }, {
          submissionId: data.submission.id,
          historicalAnswers: [{ fieldId: "consent", value: true }],
          expectedCurrentRevisionId: null,
        });
        const row = db.prepare("SELECT * FROM submission_revisions WHERE id = ?").get(saved.revisionId) as Record<string, unknown>;
        const parsed = JSON.parse(String(row.revision_json)) as Record<string, unknown>;
        const originalPolicy = parsed.callPolicy as Record<string, unknown>;
        const originalReceipt = parsed.consentReceipt as Record<string, unknown>;
        let alteredPolicy: Record<string, unknown>;
        let alteredReceipt: Record<string, unknown>;
        if (target === "policy") {
          const oversizedPrivacy = Array.from({ length: 9 }, () => "x".repeat(64 * 1024));
          const policyArtifact = {
            schema: originalPolicy.schema,
            policyVersionId: originalPolicy.policyVersionId,
            disclosure: {
              ...(originalPolicy.disclosure as Record<string, unknown>),
              privacy: oversizedPrivacy,
            },
            choices: originalPolicy.choices,
          };
          alteredPolicy = {
            ...policyArtifact,
            fingerprintAlgorithm: originalPolicy.fingerprintAlgorithm,
            fingerprint: fingerprintOf(policyArtifact),
          };
          alteredReceipt = {
            ...originalReceipt,
            policyFingerprint: alteredPolicy.fingerprint,
          };
        } else {
          const fieldId = "z".repeat(128);
          const choices = Array.from({ length: 1024 }, () => ({
            fieldId,
            statement: "retained",
            required: false,
          }));
          const policyArtifact = {
            schema: originalPolicy.schema,
            policyVersionId: originalPolicy.policyVersionId,
            disclosure: originalPolicy.disclosure,
            choices,
          };
          alteredPolicy = {
            ...policyArtifact,
            fingerprintAlgorithm: originalPolicy.fingerprintAlgorithm,
            fingerprint: fingerprintOf(policyArtifact),
          };
          alteredReceipt = {
            ...originalReceipt,
            policyFingerprint: alteredPolicy.fingerprint,
            choices: choices.map(() => ({ fieldId, value: false })),
          };
        }
        const content: Record<string, unknown> = {
          ...parsed,
          callPolicy: alteredPolicy,
          consentReceipt: alteredReceipt,
        };
        delete content.fingerprint;
        const altered = { ...content, fingerprint: fingerprintOf(content) };
        const nestedBytes = Buffer.byteLength(
          canonicalJson(target === "policy" ? alteredPolicy : alteredReceipt),
          "utf8",
        );
        expect(nestedBytes).toBeGreaterThan(target === "policy" ? LITERAL_POLICY_LIMIT : LITERAL_RECEIPT_LIMIT);
        expect(Buffer.byteLength(canonicalJson(altered), "utf8")).toBeLessThan(LITERAL_OUTER_LIMIT);
        db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
        db.prepare(
          `UPDATE submission_revisions
           SET revision_json = ?, policy_fingerprint = ?, consent_receipt_policy_fingerprint = ?, fingerprint = ?
           WHERE id = ?`,
        ).run(
          canonicalJson(altered),
          String(alteredPolicy.fingerprint),
          String(alteredReceipt.policyFingerprint),
          String(altered.fingerprint),
          saved.revisionId,
        );
        db.exec(DDL);
        expect(Buffer.byteLength(
          (db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as { revision_json: string }).revision_json,
          "utf8",
        )).toBeLessThan(LITERAL_OUTER_LIMIT);
        closeDb(db);
        db = null;
        const beforeReopen = readFileSync(path).toString("base64");
        expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
        expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
      } finally {
        if (db) closeDb(db);
        removeSqliteFiles(path);
      }
    },
  );

  it("maps hostile stored policy safety failures to fixed persistence corruption codes", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const nested = "[".repeat(40) + "0" + "]".repeat(40);
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET policy_json = ? WHERE id = ?").run(nested, data.call.id);
      db.exec(DDL);
      expect(() => readCall(db, data.organizer.workspaceId, data.call.id)).toThrowError(
        expect.objectContaining({ code: "CALL_POLICY_INVALID" }),
      );
      try {
        readCall(db, data.organizer.workspaceId, data.call.id);
      } catch (error) {
        expect(error).toBeInstanceOf(FormDocumentPersistenceError);
        expect((error as Error).message).not.toContain("depth");
      }
    } finally {
      closeDb(db);
    }
  });

  it("maps malformed stored call, draft-pin, and session identity values to fixed corruption codes", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET form_version_id = ? WHERE id = ?").run("\u0000stored-call-pin", data.call.id);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(DDL);
      expect(() => readCall(db, data.organizer.workspaceId, data.call.id)).toThrowError(
        expect.objectContaining({ code: "CALL_POLICY_MIRROR_MISMATCH" }),
      );
      db.exec("DROP TRIGGER trg_cfp_calls_workspace_update_guard");
      db.prepare("UPDATE calls SET form_version_id = ? WHERE id = ?").run(data.form.id, data.call.id);
      db.exec(DDL);

      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db.prepare("UPDATE submissions SET pinned_form_version_id = ? WHERE id = ?").run(
        "\u0000stored-draft-pin",
        data.submission.id,
      );
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(DDL);
      expect(() => saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      })).toThrowError(expect.objectContaining({ code: "SUBMISSION_PIN_MISMATCH" }));
      db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
      db.prepare("UPDATE submissions SET pinned_form_version_id = ? WHERE id = ?").run(
        data.form.id,
        data.submission.id,
      );
      db.exec(DDL);

      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TRIGGER trg_cfp_applicant_sessions_core_immutable");
      db.prepare("UPDATE cfp_applicant_sessions SET person_id = ? WHERE id = ?").run(
        "\u0000stored-session-person",
        data.applicant.sessionId,
      );
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(DDL);
      expect(() => saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      })).toThrowError(expect.objectContaining({ code: "SESSION_INVALID" }));
    } finally {
      closeDb(db);
    }
  });

  it("rejects an applicant session missing verification consumption on reopen without mutation", () => {
    const path = resolve(".tmp/unit", `cfp-session-consumption-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db = openDb({ path });
    try {
      fixture(db);
      closeDb(db);
      const raw = new DatabaseSync(path);
      try {
        raw.exec("DROP TRIGGER trg_cfp_email_verification_consumptions_no_delete");
        raw.prepare("DELETE FROM cfp_email_verification_consumptions").run();
        raw.exec(DDL);
      } finally {
        raw.close();
      }
      const before = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path).toString("base64")).toBe(before);
    } finally {
      removeSqliteFiles(path);
    }
  });

  it("rejects a receipt-null revision exactly at session expiry on live read and reopen", () => {
    const path = resolve(".tmp/unit", `cfp-revision-expiry-boundary-${process.pid}.db`);
    removeSqliteFiles(path);
    let db: Db | null = null;
    try {
      db = openDb({ path });
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET created_at = ? WHERE id = ?").run(
        "2099-08-10T00:00:00.000Z",
        saved.revisionId,
      );
      db.exec(DDL);
      expect(() => readSubmissionRevision(db!, data.organizer.workspaceId, saved.revisionId)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_MIRROR_MISMATCH" }),
      );
      expect(() => readCurrentSubmissionRevision(db!, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_MIRROR_MISMATCH" }),
      );
      closeDb(db);
      db = null;
      const beforeReopen = readFileSync(path).toString("base64");
      expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
      expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
    } finally {
      if (db) closeDb(db);
      removeSqliteFiles(path);
    }
  });

  it.each(["DRAFT", "SUBMITTED", "WITHDRAWN", "INVALIDATED"] as const)(
    "revalidates the complete revision sequence and current pointer before reading a %s submission",
    (state) => {
      const db = openDb({ path: ":memory:" });
      try {
        const data = fixture(db);
        const context = {
          workspaceId: data.organizer.workspaceId,
          sessionId: data.applicant.sessionId,
        };
        const first = saveDraftRevision(db, context, {
          submissionId: data.submission.id,
          historicalAnswers: state === "SUBMITTED" ? [{ fieldId: "consent", value: true }] : [],
          expectedCurrentRevisionId: null,
        });
        const second = saveDraftRevision(db, context, {
          submissionId: data.submission.id,
          historicalAnswers: state === "SUBMITTED" ? [{ fieldId: "consent", value: true }] : [],
          expectedCurrentRevisionId: first.revisionId,
        });
        if (state !== "DRAFT") {
          db.prepare("UPDATE submissions SET state = ? WHERE id = ?").run(state, data.submission.id);
        }
        db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
        db.prepare("UPDATE submissions SET current_revision_id = ? WHERE id = ?").run(
          first.revisionId,
          data.submission.id,
        );
        db.exec(DDL);
        expectAllRevisionReadSeamsToRejectWithoutWrite(
          db,
          data.organizer.workspaceId,
          data.submission.id,
          second.revisionId,
          "REVISION_POINTER_INVALID",
        );
      } finally {
        closeDb(db);
      }
    },
  );

  it.each([
    ["overlong caller session", (sessionId: string) => sessionId],
    ["malformed caller session", () => "\u0000caller-session"],
  ] as const)("rejects %s before any draft revision write", (_name, sessionIdFor) => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const before = revisionTruthSnapshot(db, data.submission.id);
      const sessionId = sessionIdFor("s".repeat(129));
      expect(() => saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      })).toThrowError(expect.objectContaining({ code: "SESSION_INVALID" }));
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
    } finally {
      closeDb(db);
    }
  });

  it.each(["overlong stored session", "malformed stored session"] as const)(
    "rejects an %s identity with a fixed code and complete no-write snapshot",
    (name) => {
      const db = openDb({ path: ":memory:" });
      try {
        const data = fixture(db);
        const storedSessionId = name.startsWith("overlong")
          ? "s".repeat(129)
          : "\u0000stored-session";
        db.exec("DROP TRIGGER trg_cfp_applicant_sessions_core_immutable");
        db.prepare("UPDATE cfp_applicant_sessions SET id = ? WHERE id = ?").run(
          storedSessionId,
          data.applicant.sessionId,
        );
        db.exec(DDL);
        const before = revisionTruthSnapshot(db, data.submission.id);
        expect(() => saveDraftRevision(db, {
          workspaceId: data.organizer.workspaceId,
          sessionId: storedSessionId,
        }, {
          submissionId: data.submission.id,
          historicalAnswers: [],
          expectedCurrentRevisionId: null,
        })).toThrowError(expect.objectContaining({ code: "SESSION_INVALID" }));
        expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(before);
      } finally {
        closeDb(db);
      }
    },
  );

  it("rejects a missing outer consentReceipt key with a fixed code and no write", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const row = db.prepare("SELECT revision_json FROM submission_revisions WHERE id = ?").get(saved.revisionId) as {
        revision_json: string;
      };
      const alteredContent = JSON.parse(row.revision_json) as Record<string, unknown>;
      delete alteredContent.consentReceipt;
      delete alteredContent.fingerprint;
      const altered = { ...alteredContent, fingerprint: fingerprintOf(alteredContent) };
      db.exec("DROP TRIGGER trg_cfp_submission_revisions_immutable");
      db.prepare("UPDATE submission_revisions SET revision_json = ?, fingerprint = ? WHERE id = ?").run(
        canonicalJson(altered),
        altered.fingerprint,
        saved.revisionId,
      );
      db.exec(DDL);
      const beforeRead = revisionTruthSnapshot(db, data.submission.id);
      expect(() => readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toThrowError(
        expect.objectContaining({ code: "SUBMISSION_REVISION_INVALID" }),
      );
      try {
        readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id);
      } catch (error) {
        expect(error).toBeInstanceOf(FormDocumentPersistenceError);
        expect((error as Error).message).not.toContain("undefined");
        expect((error as Error).message).not.toContain("SQLite");
      }
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforeRead);
      expect(() => db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforeRead);
    } finally {
      closeDb(db);
    }
  });

  it("rejects canonical but backdated applicant, policy, and form-update clocks", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const backdated = createCfpPersistence({ clock: () => "2026-08-09T23:59:59.000Z" });
      const beforeSaveFailure = revisionTruthSnapshot(db, data.submission.id);
      expect(() => backdated.saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
         expectedCurrentRevisionId: null,
       })).toThrowError(expect.objectContaining({ code: "SESSION_INVALID" }));
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforeSaveFailure);
      const current = readCall(db, data.organizer.workspaceId, data.call.id);
      const beforePolicyFailure = revisionTruthSnapshot(db, data.submission.id);
      expect(() => backdated.updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: current.fingerprint,
        policy: {
          disclosure: current.disclosure,
         choices: current.choices,
         },
       })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_WRITE_FAILED" }));
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforePolicyFailure);
      const nextForm = sealFormVersion(db, data.organizer, {
        formDefinitionId: data.form.formDefinitionId,
        fields: [
          { id: "trigger", type: "shortText", label: "Trigger", required: false, defaultVisibility: "visible" },
          { id: "consent", type: "consent", label: "Consent", required: false, defaultVisibility: "visible" },
          { id: "hiddenConsent", type: "acknowledgement", label: "Hidden consent", required: false, defaultVisibility: "hidden" },
          { id: "coSpeaker", type: "coSpeakerReference", label: "Co-speaker", required: false, defaultVisibility: "visible" },
        ],
        rules: { schema: FORM_RULES_SCHEMA, rules: [] },
      });
      const beforeAdvanceFailure = revisionTruthSnapshot(db, data.submission.id);
      expect(() => backdated.advanceCallFormVersion(db, data.organizer, {
        callId: data.call.id,
        expectedFormVersionId: data.form.id,
        nextFormVersionId: nextForm.id,
      })).toThrowError(expect.objectContaining({ code: "PERSISTENCE_WRITE_FAILED" }));
      expect(revisionTruthSnapshot(db, data.submission.id)).toEqual(beforeAdvanceFailure);
    } finally {
      closeDb(db);
    }
  });

  it("keeps a previously submitted revision readable after a later policy change", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id);
      const before = readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id);
      const updated = updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: before.callPolicy.fingerprint,
        policy: {
          disclosure: {
            privacy: "privacy-later",
            retention: "retention-later",
            aiProcessing: "ai-later",
            communication: "communication-later",
            consent: "consent-later",
            publication: "publication-later",
          },
          choices: [{ fieldId: "consent", statement: "Allow later", required: true }],
        },
      });
      expect(updated.fingerprint).not.toBe(before.callPolicy.fingerprint);
      expect(readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toEqual(before);
      expect(saved.revision.fingerprint).toBe(before.fingerprint);
    } finally {
      closeDb(db);
    }
  });

  it("rejects a draft-to-submitted transition when its receipt is stale for the current policy", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      const current = readCall(db, data.organizer.workspaceId, data.call.id);
      updateCallPolicy(db, data.organizer, {
        callId: data.call.id,
        expectedPolicyFingerprint: current.fingerprint,
        policy: {
          disclosure: current.disclosure,
          choices: [{ fieldId: "consent", statement: "Changed term", required: true }],
        },
      });
      expect(() => db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      expect(db.prepare("SELECT state, current_revision_id FROM submissions WHERE id = ?").get(data.submission.id)).toEqual({
        state: "DRAFT",
        current_revision_id: saved.revisionId,
      });
    } finally {
      closeDb(db);
    }
  });

  it.each(["optional-false", "zero-choice"] as const)(
    "preserves valid %s receipt evidence through read, direct submit, close, reopen, and re-read",
    (caseName) => {
      const path = resolve(".tmp/unit", `cfp-valid-receipt-${caseName}-${process.pid}.db`);
      removeSqliteFiles(path);
      let db: Db | null = null;
      try {
        db = openDb({ path });
        const data = caseName === "optional-false" ? orderedReceiptFixture(db) : fixture(db);
        if (caseName === "zero-choice") {
          const current = readCall(db, data.organizer.workspaceId, data.call.id);
          updateCallPolicy(db, data.organizer, {
            callId: data.call.id,
            expectedPolicyFingerprint: current.fingerprint,
            policy: { disclosure: current.disclosure, choices: [] },
          });
        }
        const saved = saveDraftRevision(db, {
          workspaceId: data.organizer.workspaceId,
          sessionId: data.applicant.sessionId,
        }, {
          submissionId: data.submission.id,
          historicalAnswers: caseName === "optional-false"
            ? [
              { fieldId: "firstConsent", value: false },
              { fieldId: "secondConsent", value: true },
            ]
            : [],
          expectedCurrentRevisionId: null,
        });
        expect(saved.revision.consentReceipt).not.toBeNull();
        if (caseName === "optional-false") {
          expect(saved.revision.consentReceipt?.choices).toEqual([
            { fieldId: "secondConsent", value: true },
            { fieldId: "firstConsent", value: false },
          ]);
        } else {
          expect(saved.revision.consentReceipt?.choices).toEqual([]);
        }
        expect(readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toEqual(saved.revision);
        db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id);
        expect(readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toEqual(saved.revision);
        closeDb(db);
        db = openDb({ path, seed: false });
        expect(readCurrentSubmissionRevision(db, data.organizer.workspaceId, data.submission.id)).toEqual(saved.revision);
      } finally {
        if (db) closeDb(db);
        removeSqliteFiles(path);
      }
    },
  );

  it("rejects submission when a required receipt choice is false", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: false }],
        expectedCurrentRevisionId: null,
      });
      expect(saved.revision.consentReceipt?.choices).toEqual([{ fieldId: "consent", value: false }]);
      expect(() => db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      expect(db.prepare("SELECT state, current_revision_id FROM submissions WHERE id = ?").get(data.submission.id)).toEqual({
        state: "DRAFT",
        current_revision_id: saved.revisionId,
      });
    } finally {
      closeDb(db);
    }
  });

  it("rejects submitted resurrection and deletion at the database boundary", () => {
    const db = openDb({ path: ":memory:" });
    try {
      const data = fixture(db);
      const saved = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [{ fieldId: "consent", value: true }],
        expectedCurrentRevisionId: null,
      });
      db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id);
      expect(() => db.prepare("UPDATE submissions SET state = 'DRAFT' WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions current pointer mismatch/,
      );
      expect(() => db.prepare("DELETE FROM submissions WHERE id = ?").run(data.submission.id)).toThrow(
        /submissions is retained for history/,
      );
      expect(db.prepare("SELECT state, current_revision_id FROM submissions WHERE id = ?").get(data.submission.id)).toEqual({
        state: "SUBMITTED",
        current_revision_id: saved.revisionId,
      });
    } finally {
      closeDb(db);
    }
  });

  it.each(["without current revision", "without receipt", "with required false"] as const)(
    "rejects a submitted row %s on live read and V3 reopen",
    (caseName) => {
      const path = resolve(".tmp/unit", `cfp-submitted-reopen-${caseName.replaceAll(" ", "-")}-${process.pid}.db`);
      removeSqliteFiles(path);
      let db: Db | null = null;
      try {
        db = openDb({ path });
        const data = fixture(db);
        let saved: { revisionId: string } | null = null;
        if (caseName !== "without current revision") {
          saved = saveDraftRevision(db, {
            workspaceId: data.organizer.workspaceId,
            sessionId: data.applicant.sessionId,
          }, {
            submissionId: data.submission.id,
            historicalAnswers: caseName === "with required false"
              ? [{ fieldId: "consent", value: false }]
              : [],
            expectedCurrentRevisionId: null,
          });
        }
        db.exec("DROP TRIGGER trg_cfp_submissions_workspace_update_guard");
        db.prepare("UPDATE submissions SET state = 'SUBMITTED' WHERE id = ?").run(data.submission.id);
        db.exec(DDL);
        expect(() => readCurrentSubmissionRevision(db!, data.organizer.workspaceId, data.submission.id)).toThrow();
        closeDb(db);
        db = null;
        const beforeReopen = readFileSync(path).toString("base64");
        expect(() => openDb({ path, seed: false })).toThrow(/tenant integrity check failed/);
        expect(readFileSync(path).toString("base64")).toBe(beforeReopen);
        void saved;
      } finally {
        if (db) closeDb(db);
        removeSqliteFiles(path);
      }
    },
  );

  it("proves a two-process same-pointer race has one commit, one stable stale result, and no orphan", async () => {
    const path = resolve(".tmp/unit", `cfp-race-${process.pid}.db`);
    const resultPaths = [
      `${path}.contender-a.json`,
      `${path}.contender-b.json`,
    ];
    const ownerMarker = `${path}.owner-ready`;
    const attemptMarker = `${path}.attempt-ready`;
    const ownerBeginMarker = `${path}.owner-begin`;
    removeSqliteFiles(path);
    for (const resultPath of resultPaths) rmSync(resultPath, { force: true });
    rmSync(ownerMarker, { force: true });
    rmSync(attemptMarker, { force: true });
    rmSync(ownerBeginMarker, { force: true });
    let db = openDb({ path });
    let data: ReturnType<typeof fixture>;
    let firstRevisionId: string;
    try {
      data = fixture(db);
      firstRevisionId = saveDraftRevision(db, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      }).revisionId;
    } finally {
      closeDb(db);
    }

    const children = await startPersistentRaceActors({
      testFile: "tests/unit/cfp-form-persistence.test.ts",
      testName: "race worker",
    });
    const runContender = (role: "a" | "b", resultPath: string): Promise<number> =>
      children[role === "a" ? 0 : 1]!.request({
        CFP_RACE_DB: path,
        CFP_RACE_WORKSPACE: data.organizer.workspaceId,
        CFP_RACE_SESSION: data.applicant.sessionId,
        CFP_RACE_SUBMISSION: data.submission.id,
        CFP_RACE_EXPECTED: firstRevisionId,
        CFP_RACE_RESULT: resultPath,
        CFP_RACE_ROLE: role,
        CFP_RACE_OWNER_MARKER: ownerMarker,
        CFP_RACE_ATTEMPT_MARKER: attemptMarker,
        CFP_RACE_OWNER_BEGIN_MARKER: ownerBeginMarker,
      });

    try {
      const exitCodes = await Promise.all([
        runContender("a", resultPaths[0]!),
        runContender("b", resultPaths[1]!),
      ]);
      expect(exitCodes).toEqual([0, 0]);
      const outcomes = resultPaths.map((resultPath) => JSON.parse(readFileSync(resultPath, "utf8")) as {
        result: string;
        pid: number;
      });
      expect(outcomes[0]).toMatchObject({ result: "success" });
      expect(outcomes[1]).toMatchObject({ result: "STALE_REVISION" });
      expect(new Set(outcomes.map((outcome) => outcome.pid)).size).toBe(2);
      expect(Number(readFileSync(ownerBeginMarker, "utf8"))).toBe(outcomes[0]!.pid);
      expect(Number(readFileSync(ownerMarker, "utf8"))).toBe(outcomes[0]!.pid);
      expect(Number(readFileSync(attemptMarker, "utf8"))).toBe(outcomes[1]!.pid);
      db = openDb({ path, seed: false });
      expect(db.prepare("SELECT revision_number FROM submission_revisions WHERE submission_id = ? ORDER BY revision_number").all(
        data.submission.id,
      )).toEqual([{ revision_number: 1 }, { revision_number: 2 }]);
      expect(db.prepare(
        `SELECT r.revision_number
         FROM submissions s JOIN submission_revisions r ON r.id = s.current_revision_id
         WHERE s.id = ?`,
      ).get(data.submission.id)).toEqual({ revision_number: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM submission_revisions WHERE submission_id = ?").get(
        data.submission.id,
      )).toEqual({ count: 2 });
    } finally {
      await stopPersistentRaceActors(children);
      closeDb(db);
      removeSqliteFiles(path);
      for (const resultPath of resultPaths) rmSync(resultPath, { force: true });
      rmSync(ownerMarker, { force: true });
      rmSync(attemptMarker, { force: true });
      rmSync(ownerBeginMarker, { force: true });
    }
  }, 15_000);

  it("keeps current-revision validation on one SQLite snapshot during a committed interleave", () => {
    const path = resolve(".tmp/unit", `cfp-current-snapshot-${process.pid}.db`);
    removeSqliteFiles(path);
    let firstConnection: Db | null = null;
    let secondConnection: Db | null = null;
    try {
      const setup = openDb({ path });
      const data = fixture(setup);
      const first = saveDraftRevision(setup, {
        workspaceId: data.organizer.workspaceId,
        sessionId: data.applicant.sessionId,
      }, {
        submissionId: data.submission.id,
        historicalAnswers: [],
        expectedCurrentRevisionId: null,
      });
      closeDb(setup);

      firstConnection = openDb({ path, seed: false });
      secondConnection = openDb({ path, seed: false });
      let interleaved = false;
      const hookedConnection = new Proxy(firstConnection, {
        get(target, property) {
          if (property === "prepare") {
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (interleaved || !sql.includes("SELECT current_revision_id FROM submissions")) {
                return statement;
              }
              return new Proxy(statement, {
                get(statementTarget, statementProperty) {
                  if (statementProperty === "get") {
                    return (...args: unknown[]) => {
                      const result = statementTarget.get(...(args as never[]));
                      if (!interleaved) {
                        interleaved = true;
                        saveDraftRevision(secondConnection!, {
                          workspaceId: data.organizer.workspaceId,
                          sessionId: data.applicant.sessionId,
                        }, {
                          submissionId: data.submission.id,
                          historicalAnswers: [],
                          expectedCurrentRevisionId: first.revisionId,
                        });
                      }
                      return result;
                    };
                  }
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                },
              });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as Db;

      const current = readCurrentSubmissionRevision(
        hookedConnection,
        data.organizer.workspaceId,
        data.submission.id,
      );
      expect(interleaved).toBe(true);
      expect(current.revisionNumber).toBe(1);
      expect(secondConnection.prepare(
        `SELECT revision_number FROM submission_revisions
         WHERE submission_id = ? ORDER BY revision_number`,
      ).all(data.submission.id)).toEqual([{ revision_number: 1 }, { revision_number: 2 }]);
    } finally {
      if (firstConnection) closeDb(firstConnection);
      if (secondConnection) closeDb(secondConnection);
      removeSqliteFiles(path);
    }
  });

  it("race worker", () => {
    if (process.env.SYMPOSE_PERSISTENT_RACE_ACTOR !== "1") {
      return;
    }
    return runPersistentRaceActor(() => {
      const db = openDb({ path: process.env.CFP_RACE_DB, seed: false });
      const role = process.env.CFP_RACE_ROLE;
      try {
      const save = (publicDb: Db, persistence = createCfpPersistence()): void => {
        persistence.saveDraftRevision(publicDb, {
          workspaceId: process.env.CFP_RACE_WORKSPACE!,
          sessionId: process.env.CFP_RACE_SESSION!,
        }, {
          submissionId: process.env.CFP_RACE_SUBMISSION!,
          historicalAnswers: [],
          expectedCurrentRevisionId: process.env.CFP_RACE_EXPECTED!,
        });
      };
      if (role === "a") {
        const persistence = createCfpPersistence({
          idGenerator: () => {
            expect(db.isTransaction).toBe(true);
            writeFileSync(process.env.CFP_RACE_OWNER_MARKER!, String(process.pid), "utf8");
            waitForMarker(process.env.CFP_RACE_ATTEMPT_MARKER!);
            return "race-revision-a";
          },
        });
        const publicDb = new Proxy(db, {
          get(target, property) {
            if (property === "exec") {
              return (sql: string) => {
                if (sql === "BEGIN IMMEDIATE") {
                  writeFileSync(process.env.CFP_RACE_OWNER_BEGIN_MARKER!, String(process.pid), "utf8");
                }
                return target.exec(sql);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as unknown as Db;
        try {
          save(publicDb, persistence);
          writeFileSync(process.env.CFP_RACE_RESULT!, JSON.stringify({ result: "success", pid: process.pid }), "utf8");
        } catch (error) {
          writeFileSync(process.env.CFP_RACE_RESULT!, JSON.stringify({ result: "unexpected", pid: process.pid }), "utf8");
          throw error;
        }
        return;
      }
      waitForMarker(process.env.CFP_RACE_OWNER_MARKER!);
      const publicDb = new Proxy(db, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string) => {
              if (sql === "BEGIN IMMEDIATE") {
                writeFileSync(process.env.CFP_RACE_ATTEMPT_MARKER!, String(process.pid), "utf8");
              }
              return target.exec(sql);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as Db;
      try {
        save(publicDb);
        writeFileSync(process.env.CFP_RACE_RESULT!, JSON.stringify({ result: "success", pid: process.pid }), "utf8");
      } catch (error) {
        if (error instanceof FormDocumentPersistenceError && error.code === "STALE_REVISION") {
          writeFileSync(process.env.CFP_RACE_RESULT!, JSON.stringify({ result: "STALE_REVISION", pid: process.pid }), "utf8");
          return;
        }
        writeFileSync(process.env.CFP_RACE_RESULT!, JSON.stringify({ result: "unexpected", pid: process.pid }), "utf8");
        throw error;
      }
      } finally {
        closeDb(db);
      }
    });
  });
});
