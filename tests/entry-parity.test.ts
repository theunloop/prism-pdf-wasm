/**
 * The two entry points expose the same surface.
 *
 * `index.node.ts` and `index.web.ts` exist so that one source file runs in both runtimes: the only
 * difference a consumer should ever see is that `await init()` does real work in a browser and
 * resolves immediately on Node. That promise is only as good as the two export lists matching, and
 * nothing else in the suite compares them — every other file imports one entry directly, by name,
 * so an export present in one build and missing from the other stays invisible until a consumer
 * hits it.
 *
 * It has been wrong once already: the Node entry had no default export, so
 * `import init, { Document } from "prism-pdf"` — the form the README and `docs/getting-started.md`
 * both lead with — threw `does not provide an export named 'default'` under the `node` condition.
 *
 * Importing the web entry here does not instantiate it; `index.web.ts` only touches the module
 * inside `init()`, which this file deliberately never calls. The Node entry is the live one.
 */

import { describe, expect, it } from "vitest";

import * as node from "../src/index.node.js";
import * as web from "../src/index.web.js";

describe("the two entry points", () => {
  it("export the same names", () => {
    // Sorted rather than set-compared so a failure names the missing export.
    expect(Object.keys(node).sort()).toEqual(Object.keys(web).sort());
  });

  it("both offer `init` as a default export as well as a named one", () => {
    // The default-import form is what the README leads with; it has to work in both builds.
    expect(node.default).toBe(node.init);
    expect(web.default).toBe(web.init);
  });

  it("resolves the Node `init()` immediately, through either binding", async () => {
    await expect(node.init()).resolves.toBeUndefined();
    await expect(node.default()).resolves.toBeUndefined();
  });
});
