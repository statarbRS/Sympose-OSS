import { describe, expect, it } from "vitest";

import { fingerprintOf } from "@/server/canonical";
import {
  commitmentOfferTerms,
  commitmentOfferTermsJson,
  commitmentOfferTermsMatchAuthority,
  readExactCommitmentOfferTerms,
  type CommitmentOfferTermsAuthority,
} from "@/server/services/commitment-offer-contract";

const authority: CommitmentOfferTermsAuthority = {
  planVersionId: "plan-v1",
  planFingerprint: "a".repeat(64),
  eventId: "event-1",
  eventName: "DevFlow Conf",
  timezone: "UTC",
  programUnitId: "unit-1",
  programUnitName: "Building calm developer systems",
  role: "SPEAKER",
  startsAt: "2027-09-16T10:00:00.000Z",
  endsAt: "2027-09-16T10:45:00.000Z",
};

function evidence(document: unknown) {
  return {
    termsJson: JSON.stringify(document),
    termsFingerprint: fingerprintOf(document),
  };
}

describe("commitment offer terms authority contract", () => {
  it("accepts only the complete exact producer representation and fingerprint", () => {
    const terms = commitmentOfferTerms(authority);
    const stored = {
      termsJson: commitmentOfferTermsJson(terms),
      termsFingerprint: fingerprintOf(terms),
    };
    expect(readExactCommitmentOfferTerms(stored)).toEqual(terms);
    expect(commitmentOfferTermsMatchAuthority(stored, authority)).toBe(true);
  });

  it.each([
    "planVersionId",
    "planFingerprint",
    "eventId",
    "eventName",
    "timezone",
    "programUnitId",
    "programUnitName",
    "role",
    "startsAt",
    "endsAt",
  ] as const)("rejects a self-hashed document missing %s", (missing) => {
    const entries = Object.entries(commitmentOfferTerms(authority))
      .filter(([key]) => key !== missing);
    const incomplete = Object.fromEntries(entries);
    expect(readExactCommitmentOfferTerms(evidence(incomplete))).toBeNull();
  });

  it("rejects extra, reordered, duplicate-key, and noncanonical encodings", () => {
    const terms = commitmentOfferTerms(authority);
    expect(readExactCommitmentOfferTerms(evidence({ ...terms, extraAuthority: true }))).toBeNull();
    const reordered = Object.fromEntries([
      ["eventId", terms.eventId],
      ...Object.entries(terms).filter(([key]) => key !== "eventId"),
    ]);
    expect(readExactCommitmentOfferTerms(evidence(reordered))).toBeNull();

    const duplicate = commitmentOfferTermsJson(terms).replace(
      `"eventId":"${terms.eventId}"`,
      `"eventId":"forged-event","eventId":"${terms.eventId}"`,
    );
    expect(readExactCommitmentOfferTerms({
      termsJson: duplicate,
      termsFingerprint: fingerprintOf(JSON.parse(duplicate) as unknown),
    })).toBeNull();

    const escaped = commitmentOfferTermsJson(terms).replace("DevFlow", "\\u0044evFlow");
    expect(readExactCommitmentOfferTerms({
      termsJson: escaped,
      termsFingerprint: fingerprintOf(terms),
    })).toBeNull();
  });

  it.each([
    ["planVersionId", "plan-v2"],
    ["planFingerprint", "b".repeat(64)],
    ["eventId", "event-2"],
    ["eventName", "Different event"],
    ["timezone", "America/New_York"],
    ["programUnitId", "unit-2"],
    ["programUnitName", "Different session"],
    ["role", "MODERATOR"],
    ["startsAt", "2027-09-16T10:01:00.000Z"],
    ["endsAt", "2027-09-16T10:46:00.000Z"],
  ] as const)("rejects exact evidence against changed %s authority", (field, value) => {
    const terms = commitmentOfferTerms(authority);
    expect(commitmentOfferTermsMatchAuthority({
      termsJson: commitmentOfferTermsJson(terms),
      termsFingerprint: fingerprintOf(terms),
    }, { ...authority, [field]: value })).toBe(false);
  });
});
