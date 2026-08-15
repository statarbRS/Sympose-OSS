import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContentLibrary } from "../../src/components/content-library/content-library";
import type { ContentLibraryItem, ContentLibraryProjection } from "../../src/server/services/content-library";

const styles = readFileSync(resolve("src/components/content-library/content-library.module.css"), "utf8");

function item(overrides: Partial<ContentLibraryItem>): ContentLibraryItem {
  return {
    artifactId: "a".repeat(64),
    workspaceId: "workspace-a",
    eventId: "event-a",
    personId: "person-a",
    speakerName: "Mína Speaker",
    programUnitId: "unit-a",
    sessionName: "Opening Session",
    taskId: "slides-task-a",
    taskTitle: "Upload slides",
    taskKind: "SLIDES",
    contentKind: "SLIDES",
    taskState: "SUBMITTED",
    contentVersionId: "content-version-a",
    contentHash: "1".repeat(64),
    version: 1,
    supersedesArtifactId: null,
    current: false,
    originalFilename: "deck-v1.pdf",
    mediaType: "application/pdf",
    byteSize: 111,
    sha256: "2".repeat(64),
    uploadedAt: "2026-08-13T00:00:00.000Z",
    reviewState: "SUPERSEDED",
    approvalGates: [],
    ...overrides,
  };
}

const ITEMS: readonly ContentLibraryItem[] = [
  item({}),
  item({
    artifactId: "b".repeat(64),
    contentVersionId: "content-version-b",
    contentHash: "3".repeat(64),
    version: 2,
    supersedesArtifactId: "a".repeat(64),
    current: true,
    originalFilename: "deck-v2.pdf",
    byteSize: 222,
    sha256: "4".repeat(64),
    uploadedAt: "2026-08-13T00:01:00.000Z",
    reviewState: "APPROVED",
    approvalGates: ["OPERATOR_RELEASE"],
  }),
  item({
    artifactId: "c".repeat(64),
    taskId: "headshot-task-a",
    taskTitle: "Upload headshot",
    taskKind: "HEADSHOT",
    contentKind: "HEADSHOT",
    contentVersionId: "content-version-c",
    contentHash: "5".repeat(64),
    current: true,
    originalFilename: "Mína headshot.png",
    mediaType: "image/png",
    byteSize: 333,
    sha256: "6".repeat(64),
    reviewState: "IN_REVIEW",
  }),
];

function projection(items: readonly ContentLibraryItem[] = ITEMS): ContentLibraryProjection {
  return {
    schema: "sympose-content-library/v1",
    workspaceId: "workspace-a",
    eventId: "event-a",
    items,
    versionCount: items.length,
    currentFileCount: items.filter((candidate) => candidate.current).length,
    archiveLimits: { maxFiles: 24, maxUncompressedBytes: 64 * 1024 * 1024 },
  };
}

describe("organizer Content Library UI", () => {
  it("makes the wide table a labelled, keyboard-focusable internal scroll region", () => {
    const html = renderToStaticMarkup(createElement(ContentLibrary, {
      workspace: "workspace-a-slug",
      projection: projection(),
    }));

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Immutable speaker artifact version evidence table"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('<table class=');
    expect(html).toContain('aria-label="Persisted speaker artifact versions"');
    expect(styles).toContain(".tableWrap:focus-visible");
    expect(styles).toContain("overflow-x: auto");
    expect(styles).toContain("max-width: 100%");
    expect(styles).toContain("@media (max-width: 390px)");
  });

  it("renders every version and required metadata while making only latest rows selectable", () => {
    const html = renderToStaticMarkup(createElement(ContentLibrary, {
      workspace: "workspace-a-slug",
      projection: projection(),
    }));

    for (const heading of [
      "Version / file",
      "Speaker / session",
      "Task / content",
      "Review / approval",
      "Uploaded",
      "Exact hashes",
      "Media / bytes",
      "Lineage",
    ]) expect(html).toContain(heading);
    expect(html).toContain("Persisted versions</span><strong>3");
    expect(html).toContain("Current files</span><strong>2");
    expect(html).toContain("Need approval</span><strong>1");
    expect(html).toContain("Current file work queue");
    expect(html).toContain("Immutable version evidence");
    expect(html.indexOf("Mína headshot.png")).toBeLessThan(html.indexOf("deck-v2.pdf"));
    expect(html).toContain("Mína Speaker");
    expect(html).toContain("Opening Session");
    expect(html).toContain("deck-v1.pdf");
    expect(html).toContain("deck-v2.pdf");
    expect(html).toContain("Mína headshot.png");
    expect(html).toContain("application/pdf");
    expect(html).toContain("222 bytes");
    expect(html).toContain("4".repeat(64));
    expect(html).toContain("2026-08-13T00:01:00.000Z");
    expect(html).toContain("v1");
    expect(html).toContain("v2");
    expect(html).toContain("Superseded");
    expect(html).toContain("Current latest");
    expect(html).toContain("APPROVED");
    expect(html).toContain("OPERATOR_RELEASE");
    expect(html.match(/name="artifactId"/gu)).toHaveLength(2);
    expect(html).not.toContain(`name="artifactId" value="${"a".repeat(64)}"`);
    expect(html).toContain(`name="artifactId" value="${"b".repeat(64)}"`);
    expect(html).toContain(`name="artifactId" value="${"c".repeat(64)}"`);
  });

  it("posts selected IDs to the exact event archive and links every historical version to authenticated bytes", () => {
    const html = renderToStaticMarkup(createElement(ContentLibrary, {
      workspace: "workspace-a-slug",
      projection: projection(),
    }));

    expect(html).toContain('method="post"');
    expect(html).toContain('action="/w/workspace-a-slug/events/event-a/speakers/content/archive"');
    expect(html).toContain("Download selected latest files (.zip)");
    for (const artifactId of ["a".repeat(64), "b".repeat(64), "c".repeat(64)]) {
      expect(html).toContain(`/w/workspace-a-slug/events/event-a/speakers/artifacts/${artifactId}`);
    }
    expect(html.match(/ download="/gu)).toHaveLength(5);
    expect(html).not.toContain("tenant-b-private-slides.pdf");
  });

  it("renders a truthful empty durable state without an archive form", () => {
    const html = renderToStaticMarkup(createElement(ContentLibrary, {
      workspace: "workspace-a-slug",
      projection: projection([]),
    }));

    expect(html).toContain("No persisted speaker files are available for this event.");
    expect(html).toContain("Persisted versions</span><strong>0");
    expect(html).not.toContain('method="post"');
    expect(html).not.toContain("Download selected latest files (.zip)");
  });
});
