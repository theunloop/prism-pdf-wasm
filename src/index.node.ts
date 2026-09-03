/**
 * Node entry point.
 *
 * wasm-pack's `nodejs` target instantiates the module as it is required, synchronously, from the
 * filesystem — there is nothing to await. `init()` is still exported, and still returns a promise,
 * so the same consumer code runs unchanged in both runtimes.
 */

import { createRequire } from "node:module";

import { setModule, type RawModule } from "./runtime.js";

export * from "./api.js";

// `createRequire` rather than a bare `import`: wasm-pack's nodejs output is CommonJS, and Node's
// ESM-from-CJS named-export detection does not reliably see wasm-bindgen's generated exports.
// Going through `require` gets the module object itself, with no static analysis in the way.
const require = createRequire(import.meta.url);
const raw = require("../pkg/node/prism_pdf.js") as RawModule;
setModule(raw);

/**
 * Initialise the module.
 *
 * Already done on Node — this resolves immediately and exists so that code written against the
 * browser build runs here without a change.
 */
export function init(): Promise<void> {
  return Promise.resolve();
}

/**
 * The same `init`, as a default export.
 *
 * Only here so that `import init, { Document } from "prism-pdf"` — the form the README and
 * `docs/getting-started.md` lead with — resolves under the `node` condition too. The whole point
 * of the two entry points is that one source file runs in both runtimes, and an export the web
 * build has and this one does not breaks exactly that.
 */
export default init;
