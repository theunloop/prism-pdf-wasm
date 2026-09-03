/**
 * The manipulate journey: split, rotate, merge.
 *
 * Ported from the engine's own manipulation coverage, and shaped like `parse-journey.test.ts`.
 * Every assertion here **reopens the returned bytes** rather than inspecting them, because the
 * boundary is immutable: a transform returns a new document and the source is untouched. That is
 * the only way to check the output is a PDF and not merely a non-empty buffer.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  Document,
  PrismPdfError,
  Status,
  init,
  merge,
  mergeWithReport,
} from "../src/index.node.js";
import { CORPUS, SKIP_REASON, read } from "./corpus.js";

beforeAll(async () => {
  await init();
});

/** Reopen transformed bytes and read something back, then release the handle. */
function reopen<T>(bytes: Uint8Array, inspect: (doc: Document) => T): T {
  using doc = Document.open(bytes);
  return inspect(doc);
}

function capture(call: () => unknown): PrismPdfError {
  try {
    call();
  } catch (raised) {
    if (raised instanceof PrismPdfError) return raised;
    throw raised;
  }
  throw new Error("expected a PrismPdfError, but the call succeeded");
}

describe("the manipulate journey", () => {
  it.skipIf(CORPUS === null)(SKIP_REASON, () => {});

  describe.skipIf(CORPUS === null)("extractPages — split and page subsetting", () => {
    it("keeps only the pages asked for", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      const first = doc.extractPages([0]);
      expect(reopen(first, (d) => d.pageCount)).toBe(1);
      expect(reopen(first, (d) => d.pageText(0))).toContain("Page one");
    });

    it("keeps the order given, not the source order", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      const reversed = doc.extractPages([1, 0]);
      expect(reopen(reversed, (d) => d.pageCount)).toBe(2);
      // Reversed means page 0 of the output is page 1 of the source.
      expect(reopen(reversed, (d) => d.pageText(0))).toContain("Page two");
    });

    it("can repeat a page", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      expect(reopen(doc.extractPages([0, 0, 0]), (d) => d.pageCount)).toBe(3);
    });

    it("skips an index past the last page rather than failing", () => {
      // The engine's documented behaviour, and it is kept: the argument describes a *selection*,
      // and a selection that matches nothing is empty rather than wrong. Contrast `pageText`,
      // where an out-of-range index is a caller mistake and raises NotFound.
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      expect(reopen(doc.extractPages([0, 99]), (d) => d.pageCount)).toBe(1);
    });

    it("rejects a negative index instead of wrapping it", () => {
      // Without the guard in `pageIndices` this would become 4294967295, be skipped as
      // out-of-range, and hand back a silently short document with no error.
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      const raised = capture(() => doc.extractPages([0, -1]));
      expect(raised.status).toBe(Status.NullArgument);
      expect(raised.message).toContain("-1");
    });

    it("rejects a fractional index", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      expect(capture(() => doc.extractPages([1.5])).status).toBe(Status.NullArgument);
    });

    it("leaves the source document untouched", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      doc.extractPages([0]);
      expect(doc.pageCount).toBe(2);
      expect(doc.pageText(1)).toContain("Page two");
    });

    it("reports what a reconstruction costs", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      const report = doc.extractPagesWithReport([0]);
      expect(reopen(report.bytes, (d) => d.pageCount)).toBe(1);
      // A fresh object graph cannot carry either across — §12.8 and §14.7.
      expect(report.rewriteMode).toBe("reconstructed");
      expect(report.signatureEffect).toBe("removed");
      expect(report.structureEffect).toBe("removed");
    });
  });

  describe.skipIf(CORPUS === null)("rotatePage", () => {
    it("returns a document with the same pages", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      const rotated = doc.rotatePage(0, 90);
      expect(reopen(rotated, (d) => d.pageCount)).toBe(2);
      expect(reopen(rotated, (d) => d.pageText(0))).toContain("Page one");
    });

    it("actually records the rotation", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      // No `/Rotate` getter is bound, so the observable difference is the bytes themselves:
      // setting 90 must not produce what setting 0 produces.
      expect(doc.rotatePage(0, 90)).not.toEqual(doc.rotatePage(0, 0));
    });

    it("raises Parse past the last page, matching the C ABI", () => {
      // Not NotFound, which is what contract 2 would suggest for an out-of-range index and what
      // `pageText(99)` raises. The engine returns `DocError::BadPageTree` here, and
      // `prismpdf_document_rotate_page` funnels every error to Parse
      // (`pdf-ffi/src/api/core.rs:1605`, `Err(_) => PrismPdfStatus::Parse`). Every binding
      // therefore reports Parse, and this one matches rather than inventing a better status —
      // a divergence would make the same call mean different things in different languages.
      // The inconsistency is the engine's to fix; see docs/naming.md.
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      expect(capture(() => doc.rotatePage(99, 90)).status).toBe(Status.Parse);
    });

    it("leaves the source untouched", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      const before = doc.save();
      doc.rotatePage(0, 90);
      expect(doc.save()).toEqual(before);
    });
  });

  describe.skipIf(CORPUS === null)("merge", () => {
    it("combines pages in order", () => {
      using a = Document.open(read("valid/two-pages-text.pdf"));
      using b = Document.open(read("valid/minimal-2page.pdf"));
      const combined = merge([a, b]);
      expect(reopen(combined, (d) => d.pageCount)).toBe(a.pageCount + b.pageCount);
      expect(reopen(combined, (d) => d.pageText(0))).toContain("Page one");
    });

    it("leaves every input usable afterwards", () => {
      // The accumulator clones, so the caller's handles are untouched — and the `Merger` it used
      // is freed inside the call, leaving nothing extra to dispose.
      using a = Document.open(read("valid/two-pages-text.pdf"));
      using b = Document.open(read("valid/minimal-2page.pdf"));
      merge([a, b]);
      expect(a.pageCount).toBe(2);
      expect(b.pageCount).toBe(2);
    });

    it("merges one document into a copy of itself", () => {
      using a = Document.open(read("valid/two-pages-text.pdf"));
      expect(reopen(merge([a, a]), (d) => d.pageCount)).toBe(4);
    });

    it("accepts a single document", () => {
      using a = Document.open(read("valid/two-pages-text.pdf"));
      expect(reopen(merge([a]), (d) => d.pageCount)).toBe(2);
    });

    it("raises the wrapper's error for a closed input, not a trap", () => {
      using a = Document.open(read("valid/two-pages-text.pdf"));
      const b = Document.open(read("valid/minimal-2page.pdf"));
      b.close();
      expect(capture(() => merge([a, b])).status).toBe(Status.InvalidUse);
      // And the merge that failed still released its accumulator: the next one works.
      expect(reopen(merge([a]), (d) => d.pageCount)).toBe(2);
    });

    it("reports what a merge costs", () => {
      using a = Document.open(read("valid/two-pages-text.pdf"));
      using b = Document.open(read("valid/minimal-2page.pdf"));
      const report = mergeWithReport([a, b]);
      expect(reopen(report.bytes, (d) => d.pageCount)).toBe(4);
      expect(report.rewriteMode).toBe("reconstructed");
      expect(report.signatureEffect).toBe("removed");
      expect(report.structureEffect).toBe("removed");
    });
  });
});
