/**
 * The browser entry point, exercised without a browser.
 *
 * `index.web.ts` is the half of the package a Node test suite would otherwise never touch — and
 * it is the half with the interesting failure mode, because it is the one that has to fetch and
 * instantiate the module itself. wasm-bindgen's `web` loader accepts raw bytes as well as a URL,
 * so the whole path can be driven here: same glue, same `init()`, same `Document`, just handed
 * the bytes instead of fetching them.
 *
 * CI runs the full journeys against this build under headless Chromium as well; this file is what
 * makes a broken web entry fail in one second rather than at the end of the matrix.
 */

import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { Document, PrismPdfError, Status, engineVersion, init, isReady } from "../src/index.web.js";
import { CORPUS, SKIP_REASON, read } from "./corpus.js";

const wasm = readFileSync(new URL("../pkg/web/prism_pdf_bg.wasm", import.meta.url));

beforeAll(async () => {
  expect(isReady()).toBe(false);
  await init(wasm);
});

describe("the web build", () => {
  it("instantiates and reports the engine version", () => {
    expect(isReady()).toBe(true);
    expect(engineVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("shares one instantiation across repeat calls", async () => {
    // A second `init()` must not compile the module again, and must not reject.
    await expect(init(wasm)).resolves.toBeUndefined();
    await expect(init()).resolves.toBeUndefined();
  });

  it.skipIf(CORPUS === null)(SKIP_REASON, () => {});

  it.skipIf(CORPUS === null)("reads a document through the browser glue", () => {
    using doc = Document.open(read("valid/two-pages-text.pdf"));
    expect(doc.pageCount).toBe(2);
    expect(doc.pageText(0)).toContain("Page one");
    // Byte buffers cross the browser glue by a different path than the Node one; check the
    // round-trip rather than assuming the two loaders marshal identically.
    using reopened = Document.open(doc.save());
    expect(reopened.pageCount).toBe(2);
  });

  it("raises the same error type as the Node build", () => {
    let raised: unknown;
    try {
      Document.open(new Uint8Array([1, 2, 3]));
    } catch (e) {
      raised = e;
    }
    expect(raised).toBeInstanceOf(PrismPdfError);
    expect((raised as PrismPdfError).status).toBe(Status.Parse);
  });
});
