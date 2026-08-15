import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { FORM_FIELD_TYPES as BROWSER_FORM_FIELD_TYPES } from "../../src/cfp/form-field-contract";
import { FORM_FIELD_TYPES as SERVER_FORM_FIELD_TYPES } from "../../src/server/services/cfp/form-types";

const EXPECTED_FORM_FIELD_TYPES = [
  "shortText",
  "longText",
  "richText",
  "singleChoice",
  "multipleChoice",
  "checkbox",
  "ranking",
  "matrix",
  "integer",
  "decimal",
  "date",
  "time",
  "dateTime",
  "email",
  "phone",
  "url",
  "address",
  "location",
  "fileUpload",
  "fileLink",
  "consent",
  "acknowledgement",
  "policyAcceptance",
  "personReference",
  "proposalOwnerReference",
  "coSpeakerReference",
  "section",
  "repeatableGroup",
  "calculated",
] as const;

describe("CFP form field browser contract", () => {
  it("preserves the exact field vocabulary and order", () => {
    expect(BROWSER_FORM_FIELD_TYPES).toEqual(EXPECTED_FORM_FIELD_TYPES);
    expect(Object.isFrozen(BROWSER_FORM_FIELD_TYPES)).toBe(true);
  });

  it("keeps the server export as the same contract object", () => {
    expect(SERVER_FORM_FIELD_TYPES).toBe(BROWSER_FORM_FIELD_TYPES);
  });

  it("has no Node or server imports", () => {
    const source = readFileSync(resolve("src/cfp/form-field-contract.ts"), "utf8");

    expect(source).not.toMatch(/from\s+["']node:/u);
    expect(source).not.toMatch(/from\s+["'](?:@\/server|\.\.\/server)/u);
  });
});
