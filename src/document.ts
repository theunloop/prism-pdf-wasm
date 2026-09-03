/**
 * The `Document` class — the idiomatic layer's core, and the only thing user code touches.
 *
 * This is where the engine's six semantic contracts are enforced, once, so user code cannot leak a
 * handle, use one after closing it, or misread a status. `docs/ownership.md` maps each contract to
 * the line that keeps it.
 */

import { PrismPdfError, Status, wrap } from "./errors.js";
import { raw, type RawDocument, type RawMerger } from "./runtime.js";
import type {
  Annotation,
  Attachment,
  Font,
  FormField,
  Image,
  Limits,
  OpenOptions,
  OpenReport,
  OutlineItem,
  PdfDate,
  TransformReport,
  Version,
} from "./types.js";

const encoder = new TextEncoder();

/** A zero tells the shim "use the engine default for this field". */
function limitFields(limits: Limits): [number, number, number, number, number] {
  return [
    limits.maxDepth ?? 0,
    limits.maxObjstmObjects ?? 0,
    limits.maxObjects ?? 0,
    limits.maxDecodedStream ?? 0,
    limits.maxFilterChain ?? 0,
  ];
}

/**
 * Page indices as the `Uint32Array` the shim takes.
 *
 * The shim narrows the facade's `usize` to `u32`, and an unchecked `-1` would wrap to 4294967295
 * — which the engine then *skips*, because it skips any out-of-range index. The caller would get
 * a silently short document and no error. That wrap is introduced by this binding's own
 * conversion, so this binding is where it gets caught.
 */
function pageIndices(indices: readonly number[]): Uint32Array {
  const out = new Uint32Array(indices.length);
  indices.forEach((value, i) => {
    if (!Number.isInteger(value) || value < 0) {
      throw new PrismPdfError(
        `page index must be a non-negative integer, got ${value}`,
        Status.NullArgument,
      );
    }
    out[i] = value;
  });
  return out;
}

/**
 * Module-private access to a `Document`'s live handle, assigned by the static block below.
 *
 * `merge()` is a module-level function, per naming rule 6 — it takes no receiver, so it is not a
 * method — but it still needs the handles behind its arguments. This keeps that reach inside the
 * module without widening the public class by an `@internal` static that would show up in the
 * emitted `.d.ts` anyway.
 */
let handleOf!: (doc: Document) => RawDocument;

/**
 * An open PDF document.
 *
 * Close it when you are done — with `using`, or by calling {@link close}. The wasm heap is not the
 * JavaScript heap: nothing collects an unreachable document for you, so an unclosed one is a leak
 * that grows the module's linear memory until the tab or process ends.
 *
 * ```ts
 * using doc = Document.open(bytes);
 * console.log(doc.pageCount, doc.pageText(0));
 * ```
 *
 * There is deliberately **no `Page` class**: the engine has no page handle, so page-indexed calls
 * take an index here. Every Prism PDF binding is shaped this way.
 */
export class Document {
  #handle: RawDocument | null;

  static {
    handleOf = (doc) => doc.#live;
  }

  private constructor(handle: RawDocument) {
    this.#handle = handle;
  }

  /**
   * Open a PDF from an in-memory buffer.
   *
   * @throws {PrismPdfError} `Parse` when the bytes are unreadable even after recovery, or
   * `Password` when the document is encrypted and the credentials are wrong or absent.
   */
  static open(data: Uint8Array, options: OpenOptions = {}): Document {
    const { password, limits } = options;
    if (password !== undefined && limits !== undefined) {
      // The engine has an entry point for each on its own but not for both together — the C ABI
      // pairs them only through `OpenOptions`, which this cut does not bind yet. Say so plainly
      // rather than silently dropping one of the two.
      throw new PrismPdfError(
        "open() cannot yet combine `password` with `limits`; the engine's OpenOptions handle, " +
          "which pairs them, is not bound in this release.",
        Status.NullArgument,
      );
    }
    const handle = wrap(() => {
      if (password !== undefined) {
        const bytes = typeof password === "string" ? encoder.encode(password) : password;
        return raw().Document.openWithPassword(data, bytes);
      }
      if (limits !== undefined) {
        return raw().Document.openWithLimits(data, ...limitFields(limits));
      }
      return raw().Document.open(data);
    });
    return new Document(handle);
  }

  /** The live handle, or a clear error if this document was closed. */
  get #live(): RawDocument {
    if (this.#handle === null) {
      throw new PrismPdfError("this Document has been closed", Status.InvalidUse);
    }
    return this.#handle;
  }

  /**
   * Release the document.
   *
   * Idempotent, so a `finally` block that cannot know whether the body already closed is safe.
   */
  close(): void {
    if (this.#handle !== null) {
      const handle = this.#handle;
      // Cleared first: if `free()` throws, the handle is still gone as far as the engine is
      // concerned, and a second attempt would be a double free.
      this.#handle = null;
      handle.free();
    }
  }

  /** `using doc = Document.open(...)` — explicit resource management. */
  [Symbol.dispose](): void {
    this.close();
  }

  /** Whether {@link close} has been called. */
  get closed(): boolean {
    return this.#handle === null;
  }

  // --- Structure ------------------------------------------------------------------------

  /** The number of pages. */
  get pageCount(): number {
    return wrap(() => this.#live.pageCount);
  }

  /** The header version, or `null` when the file declares none. */
  get version(): Version | null {
    return wrap(() => this.#live.version) as Version | null;
  }

  /**
   * The **minimum** version the content requires, which can be below the declared header version.
   */
  get minVersion(): Version {
    return wrap(() => this.#live.minVersion) as Version;
  }

  /** How this document opened, and what recovery it needed. */
  get openReport(): OpenReport {
    return wrap(() => this.#live.openReport) as OpenReport;
  }

  // --- Text -----------------------------------------------------------------------------

  /**
   * One page's text, in reading order.
   *
   * @throws {PrismPdfError} `NotFound` when `index` is past the last page.
   */
  pageText(index: number): string {
    return wrap(() => this.#live.pageText(index));
  }

  /**
   * One page's text with layout preserved — line breaks and gaps taken from the text matrix,
   * rather than the reading-order run {@link pageText} returns.
   */
  pageTextPositioned(index: number): string {
    return wrap(() => this.#live.pageTextPositioned(index));
  }

  /**
   * Every page's text.
   *
   * A property, per the naming rules, but extraction runs on every read — hold the result rather
   * than reading it in a loop.
   */
  get text(): string {
    return wrap(() => this.#live.text);
  }

  // --- Collections ----------------------------------------------------------------------

  /** The annotations on one page. A page with no `/Annots` yields `[]`, not an error. */
  pageAnnotations(index: number): Annotation[] {
    return wrap(() => this.#live.pageAnnotations(index)) as Annotation[];
  }

  /** The images one page draws, recursing into form XObjects (§8.10). */
  pageImages(index: number): Image[] {
    return wrap(() => this.#live.pageImages(index)) as Image[];
  }

  /** The terminal interactive form fields. `[]` when there is no AcroForm. */
  formFields(): FormField[] {
    return wrap(() => this.#live.formFields()) as FormField[];
  }

  /** The outline tree's top level; children nest inside each entry. */
  outline(): OutlineItem[] {
    return wrap(() => this.#live.outline()) as OutlineItem[];
  }

  /** Embedded files (§7.11), each decoded through its filter chain. */
  attachments(): Attachment[] {
    return wrap(() => this.#live.attachments()) as Attachment[];
  }

  /** Every font the pages reference, with its embedded program where present. */
  fonts(): Font[] {
    return wrap(() => this.#live.fonts()) as Font[];
  }

  // --- Metadata -------------------------------------------------------------------------

  /** The XMP packet (§14.3.2) as raw XML, or `null`. */
  get xmp(): string | null {
    return wrap(() => this.#live.xmp) as string | null;
  }

  /**
   * One `/Info` entry by key, decoded per §7.9.2.2 — so UTF-16BE and PDF 2.0 UTF-8 values come
   * back as JavaScript strings. `null` when absent or not a string.
   */
  info(key: string): string | null {
    return wrap(() => this.#live.info(key)) as string | null;
  }

  /** `/CreationDate`, or `null`. */
  get creationDate(): PdfDate | null {
    return wrap(() => this.#live.creationDate) as PdfDate | null;
  }

  /** `/ModDate`, or `null`. */
  get modificationDate(): PdfDate | null {
    return wrap(() => this.#live.modificationDate) as PdfDate | null;
  }

  // --- Save -----------------------------------------------------------------------------

  /**
   * Serialise with a classic cross-reference table (§7.5.4); normalises and repairs.
   *
   * The boundary is immutable: this returns **new** bytes and leaves this document untouched.
   * There is no mutating save in any Prism PDF binding — to work with the result, reopen it.
   */
  save(): Uint8Array {
    return wrap(() => this.#live.save());
  }

  /** Serialise with a cross-reference *stream* (§7.5.8, PDF 1.5+). */
  saveCompact(): Uint8Array {
    return wrap(() => this.#live.saveCompact());
  }

  /** Serialise using object streams (§7.5.7) — the smallest of the three modes. */
  savePacked(): Uint8Array {
    return wrap(() => this.#live.savePacked());
  }

  // --- Manipulate -----------------------------------------------------------------------

  /**
   * A new PDF containing only `indices`, in the order given.
   *
   * This is both "split" and "extract pages" — they are the same operation, so there is one
   * method rather than two names for it. Splitting into halves is two calls.
   *
   * An index **past the last page is skipped**, not an error. That is the engine's behaviour and
   * it is kept: the call describes a selection, and a selection that matches nothing is empty
   * rather than wrong. A negative or fractional index *is* an error — see {@link pageIndices}.
   *
   * ```ts
   * using doc = Document.open(bytes);
   * const firstHalf = doc.extractPages([0, 1, 2]);
   * ```
   */
  extractPages(indices: readonly number[]): Uint8Array {
    const packed = pageIndices(indices);
    return wrap(() => this.#live.extractPages(packed));
  }

  /**
   * {@link extractPages} with the preservation effects stated (§12.8, §14.7).
   *
   * Extraction builds a fresh object graph, so signatures and the structure tree cannot come
   * with it. The report says so explicitly rather than leaving it to be discovered.
   */
  extractPagesWithReport(indices: readonly number[]): TransformReport {
    const packed = pageIndices(indices);
    return wrap(() => this.#live.extractPagesWithReport(packed)) as TransformReport;
  }

  /**
   * A new PDF with one page rotated by `degrees`, normalised to `0..360`. Other pages are
   * unchanged.
   *
   * Unlike {@link extractPages}, this names a single page rather than describing a selection, so
   * an out-of-range index *is* a failure.
   *
   * @throws {PrismPdfError} `Parse` when `index` is past the last page. Not `NotFound`, which is
   * what {@link pageText} raises for the same mistake: the engine reports a bad page tree here,
   * and `prismpdf_document_rotate_page` maps every failure to `Parse`, so every binding says
   * `Parse`. Matching it keeps one call meaning one thing across languages; the inconsistency
   * belongs upstream, not in a binding that quietly improves on it.
   */
  rotatePage(index: number, degrees: number): Uint8Array {
    return wrap(() => this.#live.rotatePage(index, degrees));
  }

  /** {@link rotatePage} with the preservation effects stated. */
  rotatePageWithReport(index: number, degrees: number): TransformReport {
    return wrap(() => this.#live.rotatePageWithReport(index, degrees)) as TransformReport;
  }
}

/**
 * Combine several documents' pages into one, in order (§7.7.3).
 *
 * A module-level function, not a method: naming rule 6, because it has no receiver — no one
 * document is more the subject than another. It mirrors the facade's free `merge`.
 *
 * The inputs are left untouched, like every other transform here, and stay usable afterwards:
 *
 * ```ts
 * using a = Document.open(first);
 * using b = Document.open(second);
 * const combined = merge([a, b]);
 * ```
 *
 * Object-number collisions cannot occur — each source's graph is imported with independent
 * reference remapping. Signatures and structure trees are dropped, because the output is a new
 * graph; {@link mergeWithReport} states that rather than implying it.
 */
export function merge(docs: readonly Document[]): Uint8Array {
  return withMerger(docs, (merger) => merger.finish());
}

/** {@link merge} with the preservation effects stated (§12.8, §14.7). */
export function mergeWithReport(docs: readonly Document[]): TransformReport {
  return withMerger(docs, (merger) => merger.finishWithReport()) as TransformReport;
}

/**
 * Run one merge against a freshly built accumulator, and free it however the call ends.
 *
 * The `Merger` handle is an artefact of the wasm boundary, not of the API, so it is created and
 * released inside this function. A caller never learns it exists and has nothing extra to
 * dispose — which is the whole reason the deviation stays in the raw layer.
 */
function withMerger<T>(docs: readonly Document[], run: (merger: RawMerger) => T): T {
  const merger = new (raw().Merger)();
  try {
    return wrap(() => {
      for (const doc of docs) merger.add(handleOf(doc));
      return run(merger);
    });
  } finally {
    merger.free();
  }
}
