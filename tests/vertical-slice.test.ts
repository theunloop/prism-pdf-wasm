/**
 * The vertical slice from the engine's `docs/BINDINGS.md`.
 *
 * Every new binding starts here, in this order, because it exercises every convention once:
 * status codes, an owned handle, an owned string, an owned byte buffer, and both failure paths.
 * The assertions are the guide's, transposed to JavaScript — this file should stay recognisable
 * beside `VerticalSliceTests.cs` in the .NET binding.
 */

import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { Document, PrismPdfError, Status, engineVersion, init } from "../src/index.node.js";
import { CORPUS, SKIP_REASON, read } from "./corpus.js";

beforeAll(async () => {
  await init();
});

describe("the vertical slice", () => {
  it("reports the engine version", () => {
    // The engine guarantees `prismpdf_version()` equals the release tag without its `v`, so this
    // is safe to assert on exactly, not merely to shape-check.
    const tag = readEngineTag();
    expect(engineVersion()).toBe(tag);
  });

  it.skipIf(CORPUS === null)(SKIP_REASON, () => {});

  describe.skipIf(CORPUS === null)("against the shared corpus", () => {
    it("opens a valid document and counts its pages", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      expect(doc.pageCount).toBe(2);
    });

    it("extracts a page's text", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      expect(doc.pageText(0)).toContain("Page one");
    });

    it("raises Parse on garbage, not a crash", () => {
      const raised = capture(() => Document.open(new Uint8Array([1, 2, 3, 4])));
      expect(raised).toBeInstanceOf(PrismPdfError);
      expect(raised.status).toBe(Status.Parse);
      // A status with no message is a status a caller cannot act on.
      expect(raised.message.length).toBeGreaterThan(0);
    });

    it("raises NotFound past the last page — an index lookup, not absence", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      const raised = capture(() => doc.pageText(99));
      expect(raised.status).toBe(Status.NotFound);
    });

    it("round-trips through the binding itself", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      const saved = doc.save();
      expect(saved.length).toBeGreaterThan(0);

      // Reopening the bytes we just wrote, with our own reader, is the assertion that matters:
      // it proves the writer and the reader agree, without pinning golden bytes that any
      // legitimate engine change would break.
      using reopened = Document.open(saved);
      expect(reopened.pageCount).toBe(doc.pageCount);
      expect(reopened.pageText(0)).toBe(doc.pageText(0));
    });

    it("survives a caught error — the module is still usable", () => {
      capture(() => Document.open(new Uint8Array([0xff, 0xfe])));
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      expect(doc.pageCount).toBe(2);
    });
  });
});

/** Assert that `call` threw a `PrismPdfError`, and hand it back for further assertions. */
function capture(call: () => unknown): PrismPdfError {
  try {
    call();
  } catch (raised) {
    if (raised instanceof PrismPdfError) return raised;
    throw raised;
  }
  throw new Error("expected a PrismPdfError, but the call succeeded");
}

/** The pinned tag, without its `v` — what the engine promises `engineVersion()` equals. */
function readEngineTag(): string {
  return readFileSync(new URL("../ENGINE_TAG", import.meta.url), "utf8").trim().replace(/^v/, "");
}
