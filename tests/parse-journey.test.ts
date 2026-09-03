/**
 * The parse journey.
 *
 * The engine's `docs/BINDINGS.md` fixes what this must assert: open every file in
 * `corpus/{valid,malformed,edge}`, check page counts, versions and extracted text, and require
 * that **malformed files open via recovery or fail with `Parse` — never crash**. That last clause
 * is the point of the whole journey, and on this target it is stricter than elsewhere: a crash
 * here is a wasm trap that takes the module with it, so "never crash" is not a nicety.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { Document, PrismPdfError, Status, init } from "../src/index.node.js";
import { CORPUS, SKIP_REASON, read } from "./corpus.js";

beforeAll(async () => {
  await init();
});

const files = (kind: string): string[] =>
  CORPUS === null
    ? []
    : readdirSync(join(CORPUS, kind))
        .filter((name) => name.endsWith(".pdf"))
        .map((name) => `${kind}/${name}`);

describe.skipIf(CORPUS === null)("parse journey", () => {
  it.skipIf(CORPUS !== null)(SKIP_REASON, () => {});

  describe("every valid file", () => {
    it.each(files("valid"))("%s opens and reads", (path) => {
      using doc = Document.open(read(path));

      expect(doc.pageCount).toBeGreaterThan(0);

      // A header version is not guaranteed by the format, but the minimum the content requires
      // always is — and it can legitimately be *below* the declared header version.
      expect(doc.minVersion.major).toBeGreaterThanOrEqual(1);

      // Text extraction must not throw on any page, whether or not the page carries text.
      for (let page = 0; page < doc.pageCount; page++) {
        expect(typeof doc.pageText(page)).toBe("string");
      }
    });
  });

  describe("every edge-case file", () => {
    it.each(files("edge"))("%s opens", (path) => {
      using doc = Document.open(read(path));
      expect(doc.pageCount).toBeGreaterThan(0);
    });
  });

  describe("every malformed file", () => {
    // Recovery is first-class in this engine, not a fallback: most of these open. The contract is
    // that the *only* two outcomes are "opened" and "Parse" — anything else is a bug worth failing
    // over, and an uncaught trap would not even reach this assertion.
    it.each(files("malformed"))("%s recovers or fails with Parse", (path) => {
      let doc: Document | null = null;
      try {
        doc = Document.open(read(path));
      } catch (raised) {
        expect(raised).toBeInstanceOf(PrismPdfError);
        expect((raised as PrismPdfError).status).toBe(Status.Parse);
        return;
      }
      try {
        expect(doc.pageCount).toBeGreaterThanOrEqual(0);
        // `mode` reports whether the cross-reference data was rebuilt. It is deliberately not
        // asserted to be "recovered" for every file here: two of these parse their xref cleanly
        // and are malformed in some other way, so they open "strict". See
        // docs/conformance-suite.md.
        expect(["strict", "recovered"]).toContain(doc.openReport.mode);
      } finally {
        doc.close();
      }
    });
  });

  describe("collections", () => {
    it("read without error, and are empty rather than absent", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));

      // A document with no AcroForm, no outline and no attachments returns empty arrays. The ABI
      // is explicit that absence of a whole collection is not an error.
      expect(doc.formFields()).toEqual([]);
      expect(doc.outline()).toEqual([]);
      expect(doc.attachments()).toEqual([]);
      expect(doc.pageAnnotations(0)).toEqual([]);

      // Fonts, though, this file does have: it draws text.
      const fonts = doc.fonts();
      expect(fonts.length).toBeGreaterThan(0);
      expect(typeof fonts[0]!.baseFont).toBe("string");
      expect(typeof fonts[0]!.subtype).toBe("string");
    });

    it("reports an unembedded font as absence, not an error", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      // The corpus fixtures draw with Standard-14 fonts, which are by definition not embedded.
      // That is the PDF/A pre-flight answer, and it must arrive as `null` rather than a throw.
      for (const font of doc.fonts()) {
        expect(font.embedded === null || typeof font.embedded.format === "string").toBe(true);
      }
    });

    it("decodes images with the component count needed to walk them", () => {
      using doc = Document.open(read("valid/ccitt-image.pdf"));
      const images = doc.pageImages(0);
      expect(images.length).toBeGreaterThan(0);
      const image = images[0]!;
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
      expect(image.components).toBeGreaterThan(0);
      expect(["Raw", "Jpeg", "Jpeg2000", "Jbig2"]).toContain(image.kind);
      expect(image.data).toBeInstanceOf(Uint8Array);
    });
  });

  describe("metadata", () => {
    it("returns absence as null, never as an error", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));

      // Every one of these is optional in the format. A file that has none of them must read as
      // `null` five times over, with nothing thrown.
      expect(doc.xmp === null || typeof doc.xmp === "string").toBe(true);
      expect(doc.info("Title") === null || typeof doc.info("Title") === "string").toBe(true);
      expect(doc.info("NoSuchKeyAtAll")).toBeNull();
      expect(doc.creationDate === null || typeof doc.creationDate.year === "number").toBe(true);
      expect(doc.modificationDate === null || typeof doc.modificationDate.year === "number").toBe(
        true,
      );
    });
  });

  describe("the three save modes", () => {
    // All three serialise a new document and leave the input untouched; all three must reopen.
    it.each([
      ["save", (d: Document) => d.save()],
      ["saveCompact", (d: Document) => d.saveCompact()],
      ["savePacked", (d: Document) => d.savePacked()],
    ] as const)("%s round-trips", (_name, write) => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      using reopened = Document.open(write(doc));
      expect(reopened.pageCount).toBe(doc.pageCount);
      expect(reopened.pageText(0)).toBe(doc.pageText(0));
    });

    it("leaves the source document untouched", () => {
      using doc = Document.open(read("valid/two-pages-text.pdf"));
      const before = doc.pageText(0);
      doc.savePacked();
      expect(doc.pageText(0)).toBe(before);
    });
  });
});
