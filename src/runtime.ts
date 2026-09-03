/**
 * Where the instantiated wasm module lives.
 *
 * The two entry points (`index.web.ts`, `index.node.ts`) differ only in how they get a module;
 * both hand it here, and every other file in the idiomatic layer reads it from here. That is what
 * keeps one implementation of `Document` serving both runtimes.
 */

import { PrismPdfError, Status } from "./errors.js";

/** The surface the idiomatic layer uses from the generated shim. */
export interface RawModule {
  engineVersion(): string;
  Document: RawDocumentClass;
  Merger: RawMergerClass;
}

export interface RawDocumentClass {
  open(data: Uint8Array): RawDocument;
  openWithPassword(data: Uint8Array, password: Uint8Array): RawDocument;
  openWithLimits(
    data: Uint8Array,
    maxDepth: number,
    maxObjstmObjects: number,
    maxObjects: number,
    maxDecodedStream: number,
    maxFilterChain: number,
  ): RawDocument;
}

export interface RawDocument {
  free(): void;
  readonly pageCount: number;
  readonly version: unknown;
  readonly minVersion: unknown;
  readonly openReport: unknown;
  readonly text: string;
  readonly xmp: unknown;
  readonly creationDate: unknown;
  readonly modificationDate: unknown;
  pageText(index: number): string;
  pageTextPositioned(index: number): string;
  pageAnnotations(index: number): unknown;
  pageImages(index: number): unknown;
  formFields(): unknown;
  outline(): unknown;
  attachments(): unknown;
  fonts(): unknown;
  info(key: string): unknown;
  save(): Uint8Array;
  saveCompact(): Uint8Array;
  savePacked(): Uint8Array;
  extractPages(indices: Uint32Array): Uint8Array;
  extractPagesWithReport(indices: Uint32Array): unknown;
  rotatePage(index: number, degrees: number): Uint8Array;
  rotatePageWithReport(index: number, degrees: number): unknown;
}

/**
 * The shim's merge accumulator.
 *
 * It exists because the facade's `merge(&[&Document])` — a slice of borrowed handles — has no
 * wasm-bindgen representation. `merge()` in `document.ts` creates one, fills it, and frees it
 * inside a single call, so it never reaches the public API. See the `Merger` doc comment in
 * `crates/prism-pdf-wasm/src/lib.rs`.
 */
export interface RawMerger {
  free(): void;
  add(doc: RawDocument): void;
  finish(): Uint8Array;
  finishWithReport(): unknown;
}

export interface RawMergerClass {
  new (): RawMerger;
}

let module: RawModule | null = null;

/** Record the instantiated module. Called by the runtime entry point, not by user code. */
export function setModule(raw: RawModule): void {
  module = raw;
}

/** Whether {@link init} has completed. */
export function isReady(): boolean {
  return module !== null;
}

/**
 * The instantiated module, or a clear error.
 *
 * The failure this exists to explain is the one every wasm package produces at least once: a
 * browser consumer calls `Document.open` before awaiting `init()`, and without this gets an
 * inscrutable "cannot read property of null" from generated glue.
 */
export function raw(): RawModule {
  if (module === null) {
    throw new PrismPdfError(
      "Prism PDF is not initialised — `await init()` before the first call. " +
        "On Node this is done for you; in a browser it is where the .wasm is fetched.",
      Status.InvalidUse,
    );
  }
  return module;
}
