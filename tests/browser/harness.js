// The vertical slice, run inside a real browser against the `web` build.
//
// Deliberately dependency-free and served as plain ES modules: introducing a bundler here would
// test the bundler's wasm handling rather than the package's.
import init, { Document, PrismPdfError, Status, engineVersion, merge } from "/dist/index.web.js";

export async function run() {
  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, error: String(error?.message ?? error) });
    }
  };

  // No argument: the module URL is resolved relative to the glue, which is what a consumer gets
  // when they simply `await init()`. If the .wasm is not beside the JS, this is where it shows.
  await init();

  check("engineVersion", () => {
    if (!/^\d+\.\d+\.\d+/.test(engineVersion())) throw new Error(engineVersion());
  });

  const bytes = new Uint8Array(await (await fetch("/fixture.pdf")).arrayBuffer());

  let doc;
  check("open + pageCount", () => {
    doc = Document.open(bytes);
    if (doc.pageCount !== 2) throw new Error(`pageCount ${doc.pageCount}`);
  });

  check("pageText", () => {
    if (!doc.pageText(0).includes("Page one")) throw new Error(doc.pageText(0));
  });

  check("save round-trips", () => {
    const reopened = Document.open(doc.save());
    if (reopened.pageCount !== 2) throw new Error(`reopened ${reopened.pageCount}`);
    reopened.close();
  });

  check("collections", () => {
    if (!Array.isArray(doc.fonts())) throw new Error("fonts() is not an array");
    if (doc.pageAnnotations(0).length !== 0) throw new Error("expected no annotations");
  });

  check("split", () => {
    const first = Document.open(doc.extractPages([0]));
    if (first.pageCount !== 1) throw new Error(`pageCount ${first.pageCount}`);
    first.close();
  });

  check("merge", () => {
    // The `Merger` behind this lives and dies inside the call. A browser is where a leaked one
    // would eventually surface, as linear memory that only grows.
    const combined = Document.open(merge([doc, doc]));
    if (combined.pageCount !== 4) throw new Error(`pageCount ${combined.pageCount}`);
    combined.close();
  });

  check("errors carry the status", () => {
    try {
      Document.open(new Uint8Array([1, 2, 3]));
    } catch (e) {
      if (!(e instanceof PrismPdfError)) throw new Error(`not a PrismPdfError: ${e}`);
      if (e.status !== Status.Parse) throw new Error(`status ${e.status}`);
      return;
    }
    throw new Error("expected a throw");
  });

  check("dispose", () => {
    doc.close();
    try {
      doc.pageCount;
    } catch (e) {
      if (e.status !== Status.InvalidUse) throw new Error(`status ${e.status}`);
      return;
    }
    throw new Error("expected a throw after close");
  });

  return results;
}
