import { describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../../src/server/db";
import type { SessionInfo } from "../../src/server/auth";
import {
  CO_PRESENTERS_FIELD_CONFIG_SCHEMA,
  CO_PRESENTERS_VALUE_SCHEMA,
  CO_PRESENTERS_LIMITS,
  normalizeCoPresentersFieldConfig,
  normalizeCoPresentersValue,
} from "../../src/cfp/co-presenters";
import { FORM_RULES_SCHEMA, evaluateConditionalForm } from "../../src/server/services/cfp/form-evaluator";
import {
  createDraftSubmission,
  createFormDefinition,
  createCall,
  readCurrentSubmissionRevision,
  saveDraftRevision,
  sealFormVersion,
} from "../../src/server/services/cfp/form-documents";
import { readCfpOrganizerCall } from "../../src/server/services/cfp/organizer";
import { submitSubmission } from "../../src/server/services/cfp/submissions";
import { FORM_DOCUMENT_SCHEMA, normalizeFormDocument } from "../../src/server/services/cfp/form-types";

const config = {
  schema: CO_PRESENTERS_FIELD_CONFIG_SCHEMA,
  maxEntries: 2,
  roles: ["co-speaker", "moderator"],
  guidance: "List the people sharing this proposal.",
} as const;

const value = {
  schema: CO_PRESENTERS_VALUE_SCHEMA,
  entries: [
    { fullName: "Ada Lovelace", email: "Ada@Example.test", role: "co-speaker" },
    { fullName: "Grace Hopper", email: "grace@example.test", role: "moderator" },
  ],
} as const;

function coPresenterField() {
  return {
    id: "coPresenters",
    type: "longText" as const,
    label: "Co-presenters / coauthors",
    required: false,
    defaultVisibility: "visible" as const,
    config,
  };
}

function disclosure() {
  return {
    privacy: "Organizer only",
    retention: "One year",
    aiProcessing: "No AI processing is used.",
    communication: "Application updates only.",
    consent: "Terms are recorded.",
    publication: "Accepted details may be published.",
  };
}

function persistenceFixture(): {
  readonly db: Db;
  readonly workspaceId: string;
  readonly eventId: string;
  readonly callId: string;
  readonly sessionId: string;
  readonly submissionId: string;
  readonly organizerSession: SessionInfo;
} {
  const db = openDb({ path: ":memory:" });
  const workspace = db.prepare("SELECT id, slug, name FROM workspaces WHERE slug = 'northstar'").get() as {
    id: string;
    slug: string;
    name: string;
  };
  const account = db.prepare(
    "SELECT id, email, display_name, role FROM accounts WHERE workspace_id = ? ORDER BY id LIMIT 1",
  ).get(workspace.id) as { id: string; email: string; display_name: string; role: string };
  const eventId = "co-presenters-event";
  db.prepare(
    `INSERT INTO events (id, workspace_id, name, timezone, starts_at, ends_at, lifecycle, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    workspace.id,
    "Co-presenters event",
    "UTC",
    "2026-09-15T09:00:00.000Z",
    "2026-09-15T10:00:00.000Z",
    "planning",
    "2026-08-10T00:00:00.000Z",
  );
  const definition = createFormDefinition(db, { workspaceId: workspace.id, accountId: account.id }, {
    name: "Co-presenters form",
  });
  const form = sealFormVersion(db, { workspaceId: workspace.id, accountId: account.id }, {
    formDefinitionId: definition.id,
    fields: [coPresenterField()],
    rules: { schema: FORM_RULES_SCHEMA, rules: [] },
  });
  const call = createCall(db, { workspaceId: workspace.id, accountId: account.id }, {
    eventId,
    name: "Co-presenters call",
    slug: "co-presenters-call",
    formVersionId: form.id,
    accessMode: "PUBLIC",
    state: "OPEN",
    policy: { disclosure: disclosure(), choices: [] },
  });
  const callCreatedAt = (db.prepare("SELECT created_at FROM calls WHERE id = ?").get(call.id) as {
    created_at: string;
  }).created_at;

  const personId = "co-presenters-person";
  const email = "applicant@synthetic.example";
  db.prepare(
    `INSERT INTO people (id, workspace_id, canonical_email, full_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(personId, workspace.id, email, "Synthetic Applicant", "2026-08-10T00:00:00.000Z");
  db.prepare(
    `INSERT INTO cfp_email_verifications
       (id, workspace_id, call_id, email, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "co-presenters-verification",
    workspace.id,
    call.id,
    email,
    "a".repeat(64),
    "2099-08-10T00:00:00.000Z",
    callCreatedAt,
  );
  db.prepare(
    `INSERT INTO cfp_email_verification_consumptions
       (id, workspace_id, verification_id, person_id, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "co-presenters-consumption",
    workspace.id,
    "co-presenters-verification",
    personId,
    callCreatedAt,
  );
  const sessionId = "co-presenters-session";
  db.prepare(
    `INSERT INTO cfp_applicant_sessions
       (id, workspace_id, call_id, person_id, verification_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    workspace.id,
    call.id,
    personId,
    "co-presenters-verification",
    "b".repeat(64),
    callCreatedAt,
    "2099-08-10T00:00:00.000Z",
  );
  const submission = createDraftSubmission(
    db,
    { workspaceId: workspace.id, sessionId },
    { callId: call.id },
  );

  return {
    db,
    workspaceId: workspace.id,
    eventId,
    callId: call.id,
    sessionId,
    submissionId: submission.id,
    organizerSession: {
      id: "co-presenters-organizer-session",
      tokenHash: "organizer-token-hash",
      accountId: account.id,
      workspaceId: workspace.id,
      expiresAt: "2099-01-01T00:00:00.000Z",
      email: account.email,
      displayName: account.display_name,
      role: account.role,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.name,
    },
  };
}

describe("bounded CFP co-presenter value", () => {
  it("normalizes the versioned config and compact form payload into a structured answer", () => {
    const document = normalizeFormDocument({
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "co-presenters-form",
      ruleVersionId: "co-presenters-rules",
      fields: [coPresenterField()],
      historicalAnswers: [{ fieldId: "coPresenters", value: JSON.stringify(value) }],
      effectiveAnswers: [{ fieldId: "coPresenters", value: JSON.stringify(value) }],
    });

    expect(document.fields[0]?.config).toEqual(config);
    expect(document.historicalAnswers[0]?.value).toEqual({
      ...value,
      entries: [
        { fullName: "Ada Lovelace", email: "ada@example.test", role: "co-speaker" },
        { fullName: "Grace Hopper", email: "grace@example.test", role: "moderator" },
      ],
    });
    expect(evaluateConditionalForm({
      fields: [coPresenterField()],
      historicalAnswers: [{ fieldId: "coPresenters", value: JSON.stringify(value) }],
      ruleSet: { schema: FORM_RULES_SCHEMA, ruleVersionId: "co-presenters-rules", rules: [] },
    }).effectiveAnswers[0]?.value).toEqual(document.historicalAnswers[0]?.value);
  });

  it("rejects malformed, duplicate, control, role, and bounded-limit inputs", () => {
    expect(() => normalizeCoPresentersFieldConfig({ ...config, maxEntries: 5 }, "longText"))
      .toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(() => normalizeCoPresentersFieldConfig({ ...config, roles: ["moderator", " MODERATOR "] }, "longText"))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE" }));
    expect(() => normalizeCoPresentersValue({
      ...value,
      entries: [value.entries[0], value.entries[0]],
    }, normalizeCoPresentersFieldConfig(config, "longText")!))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE" }));
    expect(() => normalizeCoPresentersValue({
      ...value,
      entries: [{ ...value.entries[0], email: "not-an-email" }],
    }, normalizeCoPresentersFieldConfig(config, "longText")!))
      .toThrowError(expect.objectContaining({ code: "VALUE_INVALID" }));
    expect(() => normalizeCoPresentersValue({
      ...value,
      entries: [{ ...value.entries[0], fullName: "Bad\nName" }],
    }, normalizeCoPresentersFieldConfig(config, "longText")!))
      .toThrowError(expect.objectContaining({ code: "VALUE_INVALID" }));
    expect(() => normalizeCoPresentersValue({
      ...value,
      entries: [value.entries[0], value.entries[1], { ...value.entries[0], email: "third@example.test" }],
    }, normalizeCoPresentersFieldConfig(config, "longText")!))
      .toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(() => normalizeCoPresentersValue(
      "x".repeat(CO_PRESENTERS_LIMITS.maxSerializedBytes + 1),
      normalizeCoPresentersFieldConfig(config, "longText")!,
    )).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(() => evaluateConditionalForm({
      fields: [coPresenterField()],
      historicalAnswers: [{ fieldId: "coPresenters", value: { schema: CO_PRESENTERS_VALUE_SCHEMA, entries: [{ fullName: "A", email: "a@example.test", role: "unknown" }] } }],
      ruleSet: { schema: FORM_RULES_SCHEMA, ruleVersionId: "co-presenters-rules", rules: [] },
    })).toThrowError(expect.objectContaining({ code: "FORM_HISTORICAL_ANSWER_VALUE_INVALID" }));
  });

  it("canonicalizes emails before enforcing the final byte limit and duplicate check", () => {
    const normalizedConfig = normalizeCoPresentersFieldConfig(config, "longText")!;
    const normalized = normalizeCoPresentersValue({
      ...value,
      entries: [{
        fullName: "Ada Lovelace",
        email: "A\u0065\u0301@Example.test",
        role: "co-speaker",
      }],
    }, normalizedConfig);
    expect(normalized).toEqual({
      schema: CO_PRESENTERS_VALUE_SCHEMA,
      entries: [{
        fullName: "Ada Lovelace",
        email: "aé@example.test",
        role: "co-speaker",
      }],
    });

    expect(() => normalizeCoPresentersValue({
      ...value,
      entries: [
        { fullName: "Ada Lovelace", email: "e\u0301@example.test", role: "co-speaker" },
        { fullName: "Grace Hopper", email: "é@example.test", role: "moderator" },
      ],
    }, normalizedConfig)).toThrowError(expect.objectContaining({ code: "DUPLICATE" }));

    const expandingLocalPart = `${"a".repeat(314)}İ`;
    expect(new TextEncoder().encode(`${expandingLocalPart}@x.y`).byteLength).toBe(320);
    expect(new TextEncoder().encode(`${expandingLocalPart.toLowerCase()}@x.y`).byteLength).toBe(321);
    expect(() => normalizeCoPresentersValue({
      ...value,
      entries: [{ fullName: "Ada Lovelace", email: `${expandingLocalPart}@x.y`, role: "co-speaker" }],
    }, normalizedConfig)).toThrowError(expect.objectContaining({ code: "VALUE_INVALID" }));

    const contractingLocalPart = `${"a".repeat(314)}e\u0301`;
    expect(new TextEncoder().encode(`${contractingLocalPart}@x.y`).byteLength).toBe(321);
    const contracted = normalizeCoPresentersValue({
      ...value,
      entries: [{ fullName: "Ada Lovelace", email: `${contractingLocalPart}@x.y`, role: "co-speaker" }],
    }, normalizedConfig);
    expect(new TextEncoder().encode(contracted!.entries[0]!.email).byteLength).toBe(320);
  });

  it("fails closed for schema-tagged nonplain configs without changing legacy config handling", () => {
    class TaggedConfig {
      readonly schema = CO_PRESENTERS_FIELD_CONFIG_SCHEMA;
      readonly maxEntries = 2;
      readonly roles = ["co-speaker", "moderator"];
    }
    class LegacyConfig {
      readonly schema = "legacy-field-config/v1";
      readonly maxLength = 200;
    }

    expect(() => normalizeCoPresentersFieldConfig(new TaggedConfig(), "longText"))
      .toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(normalizeCoPresentersFieldConfig(new LegacyConfig(), "longText")).toBeNull();
    expect(normalizeCoPresentersFieldConfig({ schema: "legacy-field-config/v1", maxLength: 200 }, "longText"))
      .toBeNull();
  });

  it("keeps an optional empty structured value valid and omittable", () => {
    const normalizedConfig = normalizeCoPresentersFieldConfig(config, "longText")!;
    expect(normalizeCoPresentersValue({
      schema: CO_PRESENTERS_VALUE_SCHEMA,
      entries: [],
    }, normalizedConfig)).toEqual({
      schema: CO_PRESENTERS_VALUE_SCHEMA,
      entries: [],
    });
    expect(normalizeCoPresentersValue("", normalizedConfig)).toBeNull();
  });

  it("keeps legacy coSpeakerReference values parseable without opting into the structured variant", () => {
    const document = normalizeFormDocument({
      schema: FORM_DOCUMENT_SCHEMA,
      formVersionId: "legacy-form",
      ruleVersionId: "legacy-rules",
      fields: [{
        id: "coSpeaker",
        type: "coSpeakerReference",
        label: "Legacy co-speaker",
        required: false,
        defaultVisibility: "visible",
      }],
      historicalAnswers: [{ fieldId: "coSpeaker", value: "Legacy Speaker" }],
      effectiveAnswers: [{ fieldId: "coSpeaker", value: "Legacy Speaker" }],
    });
    expect(document.historicalAnswers[0]?.value).toBe("Legacy Speaker");
    expect(evaluateConditionalForm({
      fields: document.fields,
      historicalAnswers: document.historicalAnswers,
      ruleSet: { schema: FORM_RULES_SCHEMA, ruleVersionId: "legacy-rules", rules: [] },
    }).effectiveAnswers[0]?.value).toBe("Legacy Speaker");
  });
});

describe("co-presenter persistence and organizer projection", () => {
  it("saves the structured value in the immutable revision, resumes it, and projects role labels", () => {
    const fixture = persistenceFixture();
    try {
      const saved = saveDraftRevision(
        fixture.db,
        { workspaceId: fixture.workspaceId, sessionId: fixture.sessionId },
        {
          submissionId: fixture.submissionId,
          historicalAnswers: [{ fieldId: "coPresenters", value: JSON.stringify(value) }],
          expectedCurrentRevisionId: null,
        },
      );
      const expectedValue = {
        ...value,
        entries: [
          { fullName: "Ada Lovelace", email: "ada@example.test", role: "co-speaker" },
          { fullName: "Grace Hopper", email: "grace@example.test", role: "moderator" },
        ],
      };
      expect(saved.revision.formDocument.historicalAnswers[0]?.value).toEqual(expectedValue);
      expect(readCurrentSubmissionRevision(fixture.db, fixture.workspaceId, fixture.submissionId)
        .formDocument.historicalAnswers[0]?.value).toEqual(expectedValue);
      const stored = fixture.db.prepare(
        "SELECT revision_json FROM submission_revisions WHERE id = ?",
      ).get(saved.revisionId) as { revision_json: string };
      expect(JSON.parse(stored.revision_json).formDocument.historicalAnswers[0].value).toEqual(expectedValue);

      const projection = readCfpOrganizerCall(
        fixture.db,
        fixture.organizerSession,
        fixture.eventId,
        fixture.callId,
      );
      expect(projection.submissions[0]?.answers).toContainEqual({
        fieldId: "coPresenters",
        label: "Co-presenters / coauthors",
        value: expectedValue,
      });
      expect(fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM people WHERE workspace_id = ?",
      ).get(fixture.workspaceId)).toEqual({ count: 1 });

      const submitted = submitSubmission(fixture.db, {
        workspaceId: fixture.workspaceId,
        callId: fixture.callId,
        sessionTokenHash: "b".repeat(64),
        submissionId: fixture.submissionId,
        historicalAnswers: [{ fieldId: "coPresenters", value: JSON.stringify(value) }],
        expectedCurrentRevisionId: saved.revisionId,
      });
      expect(submitted.submissionId).toBe(fixture.submissionId);
      expect(fixture.db.prepare(
        "SELECT state FROM submissions WHERE workspace_id = ? AND id = ?",
      ).get(fixture.workspaceId, fixture.submissionId)).toEqual({ state: "SUBMITTED" });
      expect(readCurrentSubmissionRevision(fixture.db, fixture.workspaceId, fixture.submissionId)
        .formDocument.historicalAnswers[0]?.value).toEqual(expectedValue);
    } finally {
      closeDb(fixture.db);
    }
  });
});
