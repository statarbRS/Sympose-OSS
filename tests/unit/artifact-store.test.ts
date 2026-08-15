import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactStoreError,
  MAX_HEADSHOT_BYTES,
  MAX_SLIDES_BYTES,
  type ArtifactScope,
  LocalArtifactStore,
} from "../../src/server/services/artifact-store";

const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function validPdfFixture(): Buffer {
  const header = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n", "ascii");
  const objectOffset = 9;
  const pagesOffset = header.indexOf("2 0 obj");
  const xrefOffset = header.length;
  return Buffer.concat([
    header,
    Buffer.from("xref\n0 3\n0000000000 65535 f \n", "ascii"),
    Buffer.from(`${String(objectOffset).padStart(10, "0")} 00000 n \n`, "ascii"),
    Buffer.from(`${String(pagesOffset).padStart(10, "0")} 00000 n \n`, "ascii"),
    Buffer.from("trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n", "ascii"),
    Buffer.from(`${xrefOffset}\n%%EOF\n`, "ascii"),
  ]);
}
const PDF_FIXTURE = validPdfFixture();
function evaluatorSlidesFixture(): Buffer {
  const body = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
  const xrefOffset = Buffer.byteLength(body, "latin1");
  return Buffer.from(
    `${body}xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    "latin1",
  );
}
interface PdfObject { readonly id: number; readonly generation?: number; readonly body: string }
interface PdfOptions {
  readonly trailerExtra?: string;
  readonly size?: number;
  readonly offsetOverrides?: Readonly<Record<number, number>>;
}

function classicPdf(objects: readonly PdfObject[], options: PdfOptions = {}): Buffer {
  let body = "%PDF-1.7\n";
  const offsets = new Map<number, { readonly offset: number; readonly generation: number }>();
  let maximumId = 0;
  for (const object of objects) {
    const generation = object.generation ?? 0;
    offsets.set(object.id, { offset: Buffer.byteLength(body, "latin1"), generation });
    maximumId = Math.max(maximumId, object.id);
    body += `${object.id} ${generation} obj\n${object.body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${maximumId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maximumId; id += 1) {
    const entry = offsets.get(id);
    if (!entry) body += "0000000000 00000 f \n";
    else body += `${String(options.offsetOverrides?.[id] ?? entry.offset).padStart(10, "0")} ${String(entry.generation).padStart(5, "0")} n \n`;
  }
  body += `trailer\n<< /Size ${options.size ?? maximumId + 1} /Root 1 0 R ${options.trailerExtra ?? ""} >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function zeroStreamControlPdf(): Buffer {
  const output = Buffer.alloc(MAX_SLIDES_BYTES);
  const offsets: number[] = [];
  let length = 0;
  const append = (value: string | Uint8Array): void => {
    const part = typeof value === "string" ? Buffer.from(value, "ascii") : Buffer.from(value);
    part.copy(output, length);
    length += part.length;
  };
  append("%PDF-1.7\n");
  offsets[1] = length;
  append("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets[2] = length;
  append("2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n");
  const streamLength = 400_000;
  for (let id = 3; id <= 66; id += 1) {
    offsets[id] = length;
    append(`${id} 0 obj\n<< /Length ${streamLength} >>\nstream\n`);
    append(Buffer.alloc(streamLength));
    append("\nendstream\nendobj\n");
  }
  const xrefOffset = length;
  append("xref\n0 67\n0000000000 65535 f \n");
  for (let id = 1; id <= 66; id += 1) append(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  append("trailer\n<< /Size 67 /Root 1 0 R >>\nstartxref\n");
  append(`${xrefOffset}\n%%EOF\n`);
  return output.subarray(0, length);
}

function denseNameControlPdf(): Buffer {
  const prefix = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Dense /", "ascii");
  const dense = Buffer.alloc(5 * 1024 * 1024, 0x61);
  const between = Buffer.from(" >>\nendobj\n", "ascii");
  const pagesOffset = prefix.length + dense.length + between.length;
  const pages = Buffer.from("2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n", "ascii");
  const xrefOffset = pagesOffset + pages.length;
  const suffix = Buffer.from(
    `xref\n0 3\n0000000000 65535 f \n${String(9).padStart(10, "0")} 00000 n \n${String(pagesOffset).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    "ascii",
  );
  return Buffer.concat([prefix, dense, between, pages, suffix]);
}
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");
const PNG_SIGNATURE = PNG_FIXTURE.subarray(0, 8);
const PDF_PNG_POLYGLOT = Buffer.concat([
  Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nstream\n", "ascii"),
  PNG_FIXTURE.subarray(0, 8),
  Buffer.from("\nendstream\nendobj\n%%EOF\n", "ascii"),
]);

const HEADSHOT_SCOPE: ArtifactScope = {
  workspaceId: "workspace-1",
  eventId: "event-1",
  personId: "person-1",
  taskId: "task-headshot",
  kind: "HEADSHOT",
};

const SLIDES_SCOPE: ArtifactScope = {
  workspaceId: "workspace-1",
  eventId: "event-1",
  personId: "person-1",
  taskId: "task-slides",
  kind: "SLIDES",
};

const roots: string[] = [];

function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(pngCrc(body), 8 + data.length);
  return result;
}

function pngChunks(): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < PNG_FIXTURE.length;) {
    const length = PNG_FIXTURE.readUInt32BE(offset);
    chunks.push(PNG_FIXTURE.subarray(offset, offset + length + 12));
    offset += length + 12;
  }
  return chunks;
}

function pngWithChunks(chunks: readonly Buffer[]): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sympose-artifact-store-"));
  roots.push(root);
  return root;
}

function expectError(action: () => unknown, code: ArtifactStoreError["code"]): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ArtifactStoreError);
  expect((thrown as ArtifactStoreError).code).toBe(code);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalArtifactStore", () => {
  it("stores bounded PNG bytes with a path-free projection and verifies a byte roundtrip", () => {
    const root = newRoot();
    const store = new LocalArtifactStore({ rootDir: root, maxBytes: 4 * 1024 });

    const projection = store.put({
      ...HEADSHOT_SCOPE,
      mediaType: "image/png",
      originalFilename: "speaker headshot.png",
      bytes: PNG_FIXTURE,
    });

    expect(projection.workspaceId).toBe(HEADSHOT_SCOPE.workspaceId);
    expect(projection.eventId).toBe(HEADSHOT_SCOPE.eventId);
    expect(projection.personId).toBe(HEADSHOT_SCOPE.personId);
    expect(projection.taskId).toBe(HEADSHOT_SCOPE.taskId);
    expect(projection.kind).toBe("HEADSHOT");
    expect(projection.mediaType).toBe("image/png");
    expect(projection.byteSize).toBe(PNG_FIXTURE.length);
    expect(projection.displayFilename).toBe("speaker headshot.png");
    expect(projection.sha256).toBe(createHash("sha256").update(PNG_FIXTURE).digest("hex"));
    expect(projection.storageId).not.toBe(projection.displayFilename);
    expect(projection.storageFilename).toMatch(/^[a-f0-9]{64}\.bin$/u);
    expect(projection.storageFilename).not.toContain("speaker");
    expect(Object.keys(projection).some((key) => key.toLowerCase().includes("path"))).toBe(false);
    expect(JSON.stringify(projection)).not.toContain(root);

    const read = store.read(HEADSHOT_SCOPE, projection.artifactId);
    expect(Buffer.from(read.bytes)).toEqual(PNG_FIXTURE);
    expect(read.sha256).toBe(projection.sha256);
    expect(Object.keys(read).some((key) => key.toLowerCase().includes("path"))).toBe(false);
    expect(store.read(HEADSHOT_SCOPE, projection.storageId).bytes).toEqual(PNG_FIXTURE);
    expect(readdirSync(root)).toEqual([projection.storageFilename]);
  });

  it("accepts PDF bytes through the scoped overload", () => {
    const store = new LocalArtifactStore({ root: newRoot(), maxBytes: 4 * 1024 });

    const projection = store.put(SLIDES_SCOPE, {
      mediaType: "application/pdf",
      originalFilename: "deck.pdf",
      bytes: PDF_FIXTURE,
    });

    expect(projection.kind).toBe("SLIDES");
    expect(projection.mediaType).toBe("application/pdf");
    expect(store.read(projection.artifactId, SLIDES_SCOPE).bytes).toEqual(PDF_FIXTURE);
  });

  it("rejects empty, unsupported, oversize, signature-mismatched, and obvious polyglot bytes", () => {
    const root = newRoot();
    const maxBytes = Math.max(PNG_FIXTURE.length + PDF_SIGNATURE.length, PDF_FIXTURE.length, PDF_PNG_POLYGLOT.length);
    const store = new LocalArtifactStore({ rootDir: root, maxBytes });

    expectError(
      () => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "empty.png", bytes: Buffer.alloc(0) }),
      "ARTIFACT_EMPTY",
    );
    expectError(
      () => store.put({ ...HEADSHOT_SCOPE, mediaType: "text/plain", originalFilename: "wrong.txt", bytes: PNG_FIXTURE }),
      "ARTIFACT_MEDIA_TYPE_UNSUPPORTED",
    );
    expectError(
      () => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "wrong.pdf", bytes: PNG_FIXTURE }),
      "ARTIFACT_SIGNATURE_MISMATCH",
    );
    expectError(
      () => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "wrong.png", bytes: PDF_FIXTURE }),
      "ARTIFACT_SIGNATURE_MISMATCH",
    );
    expectError(
      () => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "polyglot.png", bytes: Buffer.concat([PNG_FIXTURE, PDF_SIGNATURE]) }),
      "ARTIFACT_SIGNATURE_MISMATCH",
    );
    const malformedPng = Buffer.from(PNG_FIXTURE);
    malformedPng[29] = malformedPng[29]! ^ 0x01;
    expectError(
      () => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "corrupt.png", bytes: malformedPng }),
      "ARTIFACT_SIGNATURE_MISMATCH",
    );
    expectError(
      () => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "polyglot.pdf", bytes: PDF_PNG_POLYGLOT }),
      "ARTIFACT_SIGNATURE_MISMATCH",
    );
    expectError(
      () => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "wrong-extension.pdf", bytes: PNG_FIXTURE }),
      "ARTIFACT_INPUT_INVALID",
    );
    expectError(
      () => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "large.png", bytes: Buffer.concat([PNG_FIXTURE, Buffer.alloc(maxBytes - PNG_FIXTURE.length + 1)]) }),
      "ARTIFACT_SIZE_LIMIT_EXCEEDED",
    );
  });

  it("rejects PNGs without image data, truncated PDFs, and buried PNG signatures", () => {
    const store = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: 16 * 1024 });
    // Remove the fixture's complete IDAT chunk while retaining the valid IHDR and IEND chunks.
    const noIdatPng = Buffer.concat([PNG_FIXTURE.subarray(0, 33), PNG_FIXTURE.subarray(49)]);
    expectError(
      () => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "no-idat.png", bytes: noIdatPng }),
      "ARTIFACT_SIGNATURE_MISMATCH",
    );

    expectError(
      () => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "truncated.pdf", bytes: PDF_FIXTURE.subarray(0, -5) }),
      "ARTIFACT_SIGNATURE_MISMATCH",
    );

    const buriedPng = Buffer.concat([
      PDF_FIXTURE.subarray(0, -1),
      Buffer.alloc(5 * 1024, 0x20),
      PNG_SIGNATURE,
      Buffer.from("\n%%EOF\n", "ascii"),
    ]);
    expectError(
      () => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "buried-png.pdf", bytes: buriedPng }),
      "ARTIFACT_SIGNATURE_MISMATCH",
    );
  });

  it("rejects PNG structural, CRC, zlib, and bounded-decode bypasses", () => {
    const store = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: 8 * 1024 * 1024 });
    const [ihdr, idat, iend] = pngChunks();
    const ihdrData = Buffer.from(ihdr.subarray(8, 21));
    ihdrData[8] = 16;
    ihdrData[9] = 2;
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "bad-pair.png", bytes: pngWithChunks([pngChunk("IHDR", ihdrData), idat, iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");

    const indexedHeader = Buffer.from(ihdr.subarray(8, 21));
    indexedHeader[8] = 8;
    indexedHeader[9] = 3;
    const palette = pngChunk("PLTE", Buffer.from([0, 0, 0]));
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "missing-plte.png", bytes: pngWithChunks([pngChunk("IHDR", indexedHeader), idat, iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "unknown-critical.png", bytes: pngWithChunks([ihdr, pngChunk("ABCD", Buffer.alloc(0)), idat, iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "duplicate-ihdr.png", bytes: pngWithChunks([ihdr, ihdr, idat, iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "noncontiguous-idat.png", bytes: pngWithChunks([ihdr, idat, pngChunk("tEXt", Buffer.from("x")), idat, iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "late-plte.png", bytes: pngWithChunks([ihdr, idat, palette, iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    const outOfPaletteIdat = pngChunk("IDAT", deflateSync(Buffer.from([0, 255])));
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "out-of-palette.png", bytes: pngWithChunks([pngChunk("IHDR", indexedHeader), palette, outOfPaletteIdat, iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "empty-idat.png", bytes: pngWithChunks([ihdr, pngChunk("IDAT", Buffer.alloc(0)), iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "bad-zlib.png", bytes: pngWithChunks([ihdr, pngChunk("IDAT", Buffer.from("not-zlib", "ascii")), iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    const idatData = idat.subarray(8, 8 + idat.readUInt32BE(0));
    const hiddenZlibStream = Buffer.concat([idatData, deflateSync(Buffer.from([0]))]);
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "trailing-zlib-stream.png", bytes: pngWithChunks([ihdr, pngChunk("IDAT", hiddenZlibStream), iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    const rgbaHeader = Buffer.from(ihdr.subarray(8, 21));
    rgbaHeader[8] = 8;
    rgbaHeader[9] = 6;
    const rgbaIdat = pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 255])));
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "invalid-filter.png", bytes: pngWithChunks([pngChunk("IHDR", rgbaHeader), pngChunk("IDAT", deflateSync(Buffer.from([5, 1, 2, 3, 255]))), iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "rgba-trns.png", bytes: pngWithChunks([pngChunk("IHDR", rgbaHeader), pngChunk("tRNS", Buffer.alloc(2)), rgbaIdat, iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    const indexedHeaderForTransparency = Buffer.from(ihdr.subarray(8, 21));
    indexedHeaderForTransparency[8] = 8;
    indexedHeaderForTransparency[9] = 3;
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "empty-indexed-trns.png", bytes: pngWithChunks([pngChunk("IHDR", indexedHeaderForTransparency), palette, pngChunk("tRNS", Buffer.alloc(0)), idat, iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    const truecolorHeader = Buffer.from(ihdr.subarray(8, 21));
    truecolorHeader[8] = 8;
    truecolorHeader[9] = 2;
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "trns-before-plte.png", bytes: pngWithChunks([pngChunk("IHDR", truecolorHeader), pngChunk("tRNS", Buffer.alloc(6)), palette, pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))), iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "late-trns.png", bytes: pngWithChunks([pngChunk("IHDR", rgbaHeader), rgbaIdat, pngChunk("tRNS", Buffer.alloc(2)), iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "reserved-type-bit.png", bytes: pngWithChunks([ihdr, pngChunk("abca", Buffer.alloc(0)), idat, iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");

    const badCrc = Buffer.from(PNG_FIXTURE);
    badCrc[badCrc.length - 5] ^= 1;
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "bad-crc.png", bytes: badCrc }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "trailing.png", bytes: Buffer.concat([PNG_FIXTURE, Buffer.from("payload", "ascii")]) }), "ARTIFACT_SIGNATURE_MISMATCH");

    const hugeHeader = Buffer.from(ihdr.subarray(8, 21));
    hugeHeader.writeUInt32BE(20_000, 0);
    hugeHeader.writeUInt32BE(1_000, 4);
    hugeHeader[8] = 16;
    hugeHeader[9] = 6;
    const hugeScanlines = Buffer.alloc((20_000 * 8 + 1) * 1_000);
    expectError(() => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "decode-bomb.png", bytes: pngWithChunks([pngChunk("IHDR", hugeHeader), pngChunk("IDAT", deflateSync(hugeScanlines)), iend]) }), "ARTIFACT_SIGNATURE_MISMATCH");
  });

  it("requires a bounded classic-xref PDF and ignores markers in comments or streams", () => {
    const store = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: 16 * 1024 });
    const invalidPdfs = [
      Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "ascii"),
      Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\npayload", "ascii"),
      Buffer.from("%PDF-1.7\n1 0 obj\n<< /Length 20 >>\nstream\n/Type /Catalog\nxref\nendstream\nendobj\n%%EOF\n", "ascii"),
      Buffer.from("%PDF-1.7\n% 1 0 obj /Type /Catalog xref trailer\n%%EOF\n", "ascii"),
    ];
    for (const [index, bytes] of invalidPdfs.entries()) {
      expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: `invalid-${index}.pdf`, bytes }), "ARTIFACT_SIGNATURE_MISMATCH");
    }
    const twoObjectPdf = [{ id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" }, { id: 2, body: "<< /Type /Pages /Count 0 /Kids [] >>" }] as const;
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "wrong-nonroot-offset.pdf", bytes: classicPdf(twoObjectPdf, { offsetOverrides: { 2: 10 } }) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "wrong-size.pdf", bytes: classicPdf([{ id: 1, body: "<< /Type /Catalog >>" }], { size: 999 }) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "incremental.pdf", bytes: classicPdf([{ id: 1, body: "<< /Type /Catalog >>" }], { trailerExtra: "/Prev 0" }) }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "hybrid.pdf", bytes: classicPdf([{ id: 1, body: "<< /Type /Catalog >>" }], { trailerExtra: "/XRefStm 0" }) }), "ARTIFACT_SIGNATURE_MISMATCH");
    let earlyEndstream = "%PDF-1.7\n9 0 obj\n<< /Length 999999 >>\nstream\nprefix endstream\n";
    const earlyRootOffset = Buffer.byteLength(earlyEndstream, "latin1");
    earlyEndstream += "1 0 obj\n<< /Type /Catalog >>\nendobj\n";
    const earlyXrefOffset = Buffer.byteLength(earlyEndstream, "latin1");
    earlyEndstream += `xref\n0 2\n0000000000 65535 f \n${String(earlyRootOffset).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${earlyXrefOffset}\n%%EOF\n`;
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "early-endstream.pdf", bytes: Buffer.from(earlyEndstream, "latin1") }), "ARTIFACT_SIGNATURE_MISMATCH");
    let commentStructure = "%PDF-1.7\n\\% ";
    const commentRootOffset = Buffer.byteLength(commentStructure, "latin1");
    commentStructure += "1 0 obj << /Type /Catalog >> endobj\n\\% ";
    const commentXrefOffset = Buffer.byteLength(commentStructure, "latin1");
    commentStructure += `xref\n0 2\n0000000000 65535 f \n${String(commentRootOffset).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${commentXrefOffset}\n%%EOF\n`;
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "comment-structure.pdf", bytes: Buffer.from(commentStructure, "latin1") }), "ARTIFACT_SIGNATURE_MISMATCH");

    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "literal-catalog.pdf", bytes: classicPdf([{ id: 1, body: "<< /Title ( /Type /Catalog xref ) >>" }]) }), "ARTIFACT_SIGNATURE_MISMATCH");

    let hiddenObject = "%PDF-1.7\n1 0 obj\n<< /Title (2 0 obj << /Type /Catalog >> endobj) >>\nendobj\n";
    const hiddenObjectOffset = hiddenObject.indexOf("2 0 obj");
    const hiddenXrefOffset = Buffer.byteLength(hiddenObject, "latin1");
    hiddenObject += `xref\n0 3\n0000000000 65535 f \n${String(9).padStart(10, "0")} 00000 n \n${String(hiddenObjectOffset).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 3 /Root 2 0 R >>\nstartxref\n${hiddenXrefOffset}\n%%EOF\n`;
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "literal-object.pdf", bytes: Buffer.from(hiddenObject, "latin1") }), "ARTIFACT_SIGNATURE_MISMATCH");

    let borrowedEnd = "%PDF-1.7\n1 0 obj\n<< /Title (unfinished) >>\n2 0 obj\n<< /Type /Catalog >>\nendobj\n";
    const borrowedRootOffset = borrowedEnd.indexOf("2 0 obj");
    const borrowedXrefOffset = Buffer.byteLength(borrowedEnd, "latin1");
    borrowedEnd += `xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n${String(borrowedRootOffset).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 3 /Root 2 0 R >>\nstartxref\n${borrowedXrefOffset}\n%%EOF\n`;
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "borrowed-endobj.pdf", bytes: Buffer.from(borrowedEnd, "latin1") }), "ARTIFACT_SIGNATURE_MISMATCH");

    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "duplicate-root.pdf", bytes: classicPdf([{ id: 1, body: "<< /Type /Catalog >>" }], { trailerExtra: "/Root 2 0 R" }) }), "ARTIFACT_SIGNATURE_MISMATCH");

    const missingObjectZero = PDF_FIXTURE.toString("latin1").replace("xref\n0 3\n0000000000 65535 f \n", "xref\n1 2\n");
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "missing-object-zero.pdf", bytes: Buffer.from(missingObjectZero, "latin1") }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "duplicate-endobj.pdf", bytes: Buffer.from(PDF_FIXTURE.toString("latin1").replace("endobj\n", "endobj\nendobj\n"), "latin1") }), "ARTIFACT_SIGNATURE_MISMATCH");
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "escaped-catalog-name.pdf", bytes: classicPdf([{ id: 1, body: "<< /Type /Catalog#58NotCatalog >>" }]) }), "ARTIFACT_SIGNATURE_MISMATCH");

    const densePdf = Buffer.from(`%PDF-1.7\n${"1 0 obj\nendobj\n".repeat(5000)}%%EOF\n`, "latin1");
    const denseStore = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: MAX_SLIDES_BYTES });
    expectError(() => denseStore.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "dense.pdf", bytes: densePdf }), "ARTIFACT_SIGNATURE_MISMATCH");

    let usedZero = "%PDF-1.7\n0 0 obj\n<< /Type /Catalog >>\nendobj\n1 0 obj\n<< /Pages 0 0 R >>\nendobj\n";
    const usedZeroXrefOffset = Buffer.byteLength(usedZero, "latin1");
    usedZero += `xref\n0 2\n${String(9).padStart(10, "0")} 00000 n \n${String(usedZero.indexOf("1 0 obj")).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 2 /Root 0 0 R >>\nstartxref\n${usedZeroXrefOffset}\n%%EOF\n`;
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "used-zero.pdf", bytes: Buffer.from(usedZero, "latin1") }), "ARTIFACT_SIGNATURE_MISMATCH");

    const stringFixture = classicPdf([
      { id: 1, body: "<< /Type /Catalog /Pages 2 0 R /Title (nested (escaped \\) text)) /Hex <2f54797065> >>" },
      { id: 2, body: "<< /Type /Pages /Count 0 /Kids [] >>" },
    ]);
    expect(store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "nested-strings.pdf", bytes: stringFixture }).byteSize).toBe(stringFixture.length);
    expect(store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "valid.pdf", bytes: PDF_FIXTURE }).byteSize).toBe(PDF_FIXTURE.length);
  });

  it("rejects the six bounded PDF grammar controls", () => {
    const store = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: MAX_SLIDES_BYTES });
    const controls: readonly [string, Buffer][] = [
      ["catalog-extra", classicPdf([{ id: 1, body: "<< /Type /Catalog_Extra >>" }])],
      ["object-prefix", Buffer.from(classicPdf([{ id: 1, body: "<< /Type /Catalog >>" }]).toString("latin1").replace("1 0 obj", "x1 0 obj"), "latin1")],
      ["hyphenated-endobj", Buffer.from(classicPdf([{ id: 1, body: "<< /Type /Catalog >>" }]).toString("latin1").replace("endobj\n", "-endobj\n"), "latin1")],
      ["invalid-hex", classicPdf([{ id: 1, body: "<< /Type /Catalog /Title <zz> >>" }])],
      ["missing-pages-reference", classicPdf([{ id: 1, body: "<< /Type /Catalog /Pages 99 0 R >>" }])],
      ["trailer-junk", Buffer.from(classicPdf([{ id: 1, body: "<< /Type /Catalog >>" }]).toString("latin1").replace(">>\nstartxref", ">>\nnoise\nstartxref"), "latin1")],
    ];
    for (const [name, bytes] of controls) {
      expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: `${name}.pdf`, bytes }), "ARTIFACT_SIGNATURE_MISMATCH");
    }
  });

  it("rejects malformed headers, streamed catalogs, and invalid page trees", () => {
    const store = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: MAX_SLIDES_BYTES });
    for (const header of ["%PDF-9.7", "%PDF-1x7", "%PDF-ab7", "%PDF-1.8"]) {
      const bytes = Buffer.from(PDF_FIXTURE);
      bytes.write(header, 0, "ascii");
      expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "bad-header.pdf", bytes }), "ARTIFACT_SIGNATURE_MISMATCH");
    }
    const controls: readonly [string, readonly PdfObject[]][] = [
      ["catalog-stream", [
        { id: 1, body: "<< /Type /Catalog /Pages 2 0 R /Length 0 >>\nstream\n\nendstream" },
        { id: 2, body: "<< /Type /Pages /Count 0 /Kids [] >>" },
      ]],
      ["pages-scalar", [{ id: 1, body: "<< /Type /Catalog /Pages 2 >>" }]],
      ["pages-wrong-type", [
        { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { id: 2, body: "<< /Type /Page >>" },
      ]],
      ["pages-self", [{ id: 1, body: "<< /Type /Catalog /Pages 1 0 R >>" }]],
      ["kids-dangling", [
        { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { id: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
      ]],
      ["kids-cycle", [
        { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { id: 2, body: "<< /Type /Pages /Count 1 /Kids [2 0 R] >>" },
      ]],
      ["count-mismatch", [
        { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { id: 2, body: "<< /Type /Pages /Count 2 /Kids [3 0 R] >>" },
        { id: 3, body: "<< /Type /Page /Parent 2 0 R >>" },
      ]],
      ["duplicate-kid", [
        { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { id: 2, body: "<< /Type /Pages /Count 2 /Kids [3 0 R 3 0 R] >>" },
        { id: 3, body: "<< /Type /Page /Parent 2 0 R >>" },
      ]],
      ["dangling-parent", [
        { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
        { id: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
        { id: 3, body: "<< /Type /Page /Parent 99 0 R >>" },
      ]],
    ];
    for (const [name, objects] of controls) {
      expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: `${name}.pdf`, bytes: classicPdf(objects) }), "ARTIFACT_SIGNATURE_MISMATCH");
    }
  });

  it("accepts only the bounded evaluator catalog-only slides fixture", () => {
    const store = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: MAX_SLIDES_BYTES });
    const fixture = evaluatorSlidesFixture();
    expect(store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "slides.pdf", bytes: fixture }).byteSize).toBe(fixture.length);
    expectError(
      () => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "catalog-extra.pdf", bytes: classicPdf([{ id: 1, body: "<< /Type /Catalog /Title (extra) >>" }]) }),
      "ARTIFACT_SIGNATURE_MISMATCH",
    );
  });

  it("rejects excessive page-tree depth without recursive traversal", () => {
    const depth = 300;
    const objects: PdfObject[] = [{ id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" }];
    for (let id = 2; id < depth + 2; id += 1) {
      const parent = id === 2 ? "" : ` /Parent ${id - 1} 0 R`;
      objects.push({ id, body: `<< /Type /Pages /Count 1 /Kids [${id + 1} 0 R]${parent} >>` });
    }
    objects.push({ id: depth + 2, body: `<< /Type /Page /Parent ${depth + 1} 0 R >>` });
    const store = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: MAX_SLIDES_BYTES });
    const started = performance.now();
    expectError(
      () => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "deep-pages.pdf", bytes: classicPdf(objects) }),
      "ARTIFACT_SIGNATURE_MISMATCH",
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("rejects an oversized dense scalar within a bounded parse window", () => {
    const store = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: MAX_SLIDES_BYTES });
    const bytes = denseNameControlPdf();
    const started = performance.now();
    expectError(() => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "dense-value.pdf", bytes }), "ARTIFACT_SIGNATURE_MISMATCH");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("validates a deterministic 25 MiB, 64-stream PDF within the resource floor", () => {
    const store = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: MAX_SLIDES_BYTES });
    const bytes = zeroStreamControlPdf();
    expect(bytes.length).toBeLessThanOrEqual(MAX_SLIDES_BYTES);
    const started = performance.now();
    expect(store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "resource-control.pdf", bytes }).byteSize).toBe(bytes.length);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("enforces the PNG headshot and PDF slide ceilings independently", () => {
    const store = new LocalArtifactStore({ rootDir: newRoot() });
    const oversizedHeadshot = Buffer.alloc(MAX_HEADSHOT_BYTES + 1);
    PNG_FIXTURE.copy(oversizedHeadshot);
    const oversizedSlides = Buffer.alloc(MAX_SLIDES_BYTES + 1);
    PDF_FIXTURE.copy(oversizedSlides);

    expectError(
      () => store.put({ ...HEADSHOT_SCOPE, mediaType: "image/png", originalFilename: "large-headshot.png", bytes: oversizedHeadshot }),
      "ARTIFACT_SIZE_LIMIT_EXCEEDED",
    );
    expectError(
      () => store.put({ ...SLIDES_SCOPE, mediaType: "application/pdf", originalFilename: "large-slides.pdf", bytes: oversizedSlides }),
      "ARTIFACT_SIZE_LIMIT_EXCEEDED",
    );
  });

  it("keeps traversal-like display names out of storage paths and requires an absolute root", () => {
    expectError(
      () => new LocalArtifactStore({ rootDir: "relative-artifact-root" }),
      "ARTIFACT_ROOT_INVALID",
    );

    const root = newRoot();
    const store = new LocalArtifactStore({ rootDir: root, maxBytes: 4 * 1024 });
    const projection = store.put({
      ...SLIDES_SCOPE,
      mediaType: "application/pdf",
      originalFilename: "../../outside/../slides deck.pdf",
      bytes: PDF_FIXTURE,
    });

    expect(projection.displayFilename).toBe("slides deck.pdf");
    expect(projection.storageFilename).not.toContain("/");
    expect(projection.storageFilename).not.toContain("\\");
    expect(resolve(root, projection.storageFilename)).toBe(join(root, projection.storageFilename));
    expect(readdirSync(root)).toEqual([projection.storageFilename]);
    expect(existsSync(join(root, "..", "slides deck.pdf"))).toBe(false);
  });

  it("fails reads when any scope field differs", () => {
    const store = new LocalArtifactStore({ rootDir: newRoot(), maxBytes: 4 * 1024 });
    const projection = store.put({
      ...HEADSHOT_SCOPE,
      mediaType: "image/png",
      originalFilename: "headshot.png",
      bytes: PNG_FIXTURE,
    });

    const mismatches: readonly [keyof ArtifactScope, string][] = [
      ["workspaceId", "workspace-2"],
      ["eventId", "event-2"],
      ["personId", "person-2"],
      ["taskId", "task-other"],
      ["kind", "SLIDES"],
    ];
    for (const [field, value] of mismatches) {
      const wrongScope = { ...HEADSHOT_SCOPE, [field]: value } as ArtifactScope;
      expectError(() => store.read(wrongScope, projection.artifactId), "ARTIFACT_SCOPE_MISMATCH");
    }
  });

  it("creates immutable versions for re-uploads without overwriting earlier bytes", () => {
    const root = newRoot();
    const store = new LocalArtifactStore({ rootDir: root, maxBytes: 4 * 1024 });
    const firstBytes = PNG_FIXTURE;
    const secondBytes = PNG_FIXTURE;

    const first = store.put({
      ...HEADSHOT_SCOPE,
      mediaType: "image/png",
      originalFilename: "headshot.png",
      bytes: firstBytes,
    });
    const second = store.put({
      ...HEADSHOT_SCOPE,
      mediaType: "image/png",
      originalFilename: "headshot.png",
      bytes: secondBytes,
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.supersedesArtifactId).toBe(first.artifactId);
    expect(second.artifactId).not.toBe(first.artifactId);
    expect(second.storageId).not.toBe(first.storageId);
    expect(store.read(HEADSHOT_SCOPE, first.artifactId).bytes).toEqual(firstBytes);
    expect(store.read(HEADSHOT_SCOPE, second.artifactId).bytes).toEqual(secondBytes);
    expect(readdirSync(root).sort()).toEqual([first.storageFilename, second.storageFilename].sort());
  });
});
