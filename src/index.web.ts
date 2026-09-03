/**
 * Browser entry point.
 *
 * The `.wasm` is a separate file that has to be fetched and compiled, so initialisation is
 * genuinely asynchronous here and `init()` must be awaited before the first call. Calling into the
 * API before that raises a `PrismPdfError` that says so, rather than failing inside generated glue.
 */

import __wbg_init, { type InitInput } from "../pkg/web/prism_pdf.js";
import * as raw from "../pkg/web/prism_pdf.js";
import { isReady, setModule, type RawModule } from "./runtime.js";

export * from "./api.js";

let pending: Promise<void> | null = null;

/**
 * Fetch and instantiate the WebAssembly module.
 *
 * Call once, and await it before anything else:
 *
 * ```ts
 * import init, { Document } from "prism-pdf";
 * await init();
 * ```
 *
 * With no argument the module is resolved relative to this script, which is what a bundler
 * (Vite, webpack, Next) wires up for you. Pass `input` to load it from somewhere else — a CDN
 * URL, a `Response`, or bytes you already have.
 *
 * Concurrent and repeat calls share one instantiation rather than compiling the module twice.
 */
export function init(input?: InitInput): Promise<void> {
  if (isReady()) return Promise.resolve();
  pending ??= __wbg_init(input === undefined ? undefined : { module_or_path: input }).then(() => {
    setModule(raw as unknown as RawModule);
  });
  return pending;
}

export default init;
