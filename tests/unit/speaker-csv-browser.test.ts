import { describe, expect, it } from "vitest";

import { readBoundedSpeakerCsvInput } from "../../src/app/w/[workspace]/events/[eventId]/speakers/actions";
import { createSyntheticSpeakerOperationsRepository } from "../../src/server/services/speaker-operations";

const EVENT = { id: "csv-browser-event", name: "CSV Browser Event", timezone: "UTC", startsAt: "2026-09-01T09:00:00.000Z", endsAt: "2026-09-01T17:00:00.000Z" } as const;
const SCOPE = { kind: "organizer" as const, workspaceId: "csv-browser-workspace", eventId: EVENT.id, actorId: "csv-browser-organizer" };

describe("speaker CSV browser intake", () => {
  it("decodes an actual UTF-8 File with the evaluator header and retains Dana mapping", async () => {
    const formData = new FormData();
    formData.append("csvFile", new File([
      "name,email,title,company,bio\nDana Example,dana@example.test,Staff Engineer,Example Labs,Builds evidence-aware systems\n",
    ], "speakers.csv", { type: "text/csv" }));
    const csvText = await readBoundedSpeakerCsvInput(formData);
    const repository = createSyntheticSpeakerOperationsRepository();
    const receipt = repository.importSpeakerCsv(SCOPE, EVENT, csvText);
    expect(receipt.columns).toEqual(["name", "email", "title", "company", "bio"]);
    expect(receipt.createdCount).toBe(1);
    const projection = repository.getOrganizerProjection(SCOPE, EVENT);
    const dana = projection.roster.find((record) => record.person.fullName === "Dana Example");
    expect(dana?.person.organization).toBe("Example Labs");
    expect(dana?.person.title).toBe("Staff Engineer");
    expect(dana?.profile.eventOverride.bio).toBe("Builds evidence-aware systems");
  });

  it("uses the legacy textarea fallback and rejects bad MIME, invalid UTF-8, and oversize files", async () => {
    const legacy = new FormData();
    legacy.set("csvText", "full_name,email,organization,title,role,program_unit\nLegacy Speaker,legacy@example.test,Legacy Org,Speaker,SPEAKER,Session");
    await expect(readBoundedSpeakerCsvInput(legacy)).resolves.toContain("full_name,email");

    const wrongType = new FormData();
    wrongType.append("csvFile", new File(["name,email,title,company,bio\n"], "speakers.csv", { type: "image/png" }));
    await expect(readBoundedSpeakerCsvInput(wrongType)).rejects.toThrow("INVALID_SPEAKER_COMMAND");

    const invalidUtf8 = new FormData();
    invalidUtf8.append("csvFile", new File([new Uint8Array([0xff, 0xfe])], "speakers.csv", { type: "text/csv" }));
    await expect(readBoundedSpeakerCsvInput(invalidUtf8)).rejects.toThrow("INVALID_SPEAKER_COMMAND");

    const oversized = new FormData();
    oversized.append("csvFile", new File([new Uint8Array(64_000 * 4 + 1)], "speakers.csv", { type: "text/csv" }));
    await expect(readBoundedSpeakerCsvInput(oversized)).rejects.toThrow("INVALID_SPEAKER_COMMAND");
  });
});
