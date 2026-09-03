//! Prism PDF for WebAssembly — the raw layer.
//!
//! This crate is one of the binding's two layers (the engine's `docs/BINDINGS.md`, "Architecture:
//! two layers, always"). It is a mechanical projection of the engine's `prismpdf` facade into
//! wasm-bindgen exports: it owns handle lifetime and the status mapping, and nothing else. The
//! idiomatic layer — disposal, `null`, the error class, `init()` — is `src/` in TypeScript.
//!
//! Why the facade and not the C ABI: the engine's `DESIGN.md` §6.2 names wasm-bindgen as the
//! tier-1 path for Browser/JS, alongside PyO3 for Python and napi-rs for Node, precisely so these
//! three do not pay for a C boundary that buys them nothing. `docs/architecture.md` records the
//! consequences of that choice; the naming rules and the semantic contracts of `BINDINGS.md`
//! still apply in full, and `docs/naming.md` records every deviation.

// The engine forbids panicking paths in code that parses hostile input, and on this target a panic
// is a trap that takes the whole module with it (docs/wasm-constraints.md). Neither is a lint that
// can be left to a reviewer.
#![deny(clippy::unwrap_used, clippy::expect_used)]

mod error;
mod js;
mod read;

use wasm_bindgen::prelude::*;

use error::{Status, error, from_doc, from_facade};

/// Everything fallible returns this: a value, or the structured error `src/errors.ts` converts.
type Fallible<T> = Result<T, JsValue>;

/// The engine version this package was built against.
///
/// Naming rule 6: a function taking no handle is a static on the top-level class. The TypeScript
/// layer re-exports it as `PrismPdf.version()`.
///
/// Unlike the native ABI's `prismpdf_version`, which reads `pdf-ffi`'s own crate version, this
/// reads the version recorded at build time from the pinned engine tag — the same string, by a
/// different route, because a wasm-bindgen shim has no way to call a C function that returns a
/// static `char *`.
#[wasm_bindgen(js_name = engineVersion)]
#[must_use]
pub fn engine_version() -> String {
    env!("PRISM_PDF_ENGINE_VERSION").to_string()
}

/// An open PDF document.
///
/// One class per owned handle, named after the handle minus its `PrismPdf` prefix — the inventory
/// `BINDINGS.md` fixes. There is deliberately **no `Page` type**: the engine has no page handle,
/// so page-indexed calls take an index on the document, exactly as they do in every other binding.
#[wasm_bindgen]
pub struct Document {
    inner: prismpdf::Document,
}

#[wasm_bindgen]
impl Document {
    /// `Document.open(bytes)` — open from an in-memory buffer.
    ///
    /// Naming rule 3: `document_open*` are static factories. The three variants stay three
    /// entry points rather than one with optional arguments, so the cheap path stays cheap.
    pub fn open(data: &[u8]) -> Fallible<Document> {
        prismpdf::Document::open(data.to_vec())
            .map(|inner| Document { inner })
            .map_err(from_doc)
    }

    /// Open an encrypted document (§7.6). The password is tried as both user and owner; a wrong
    /// one is `Password`, not `Parse`.
    #[wasm_bindgen(js_name = openWithPassword)]
    pub fn open_with_password(data: &[u8], password: &[u8]) -> Fallible<Document> {
        prismpdf::Document::open_with_password(data.to_vec(), password)
            .map(|inner| Document { inner })
            .map_err(from_doc)
    }

    /// Open with explicit anti-DoS limits (`DESIGN.md` §3.5) — the knob a service parsing
    /// untrusted uploads needs, and the one a browser tab wants most: `maxDecodedStream` is the
    /// decompression-bomb guard.
    ///
    /// Positional and unadorned on purpose. This is the raw layer; `Document.open(bytes, { limits })`
    /// in `src/document.ts` is where the options object and its defaults live. A zero means "use
    /// the engine default for this field", which is also how the C ABI's `PrismPdfLimits` reads a
    /// zero field.
    #[wasm_bindgen(js_name = openWithLimits)]
    pub fn open_with_limits(
        data: &[u8],
        max_depth: usize,
        max_objstm_objects: usize,
        max_objects: usize,
        max_decoded_stream: usize,
        max_filter_chain: usize,
    ) -> Fallible<Document> {
        let d = prismpdf::Limits::default();
        let or_default = |value: usize, fallback: usize| if value == 0 { fallback } else { value };
        let limits = prismpdf::Limits {
            max_depth: or_default(max_depth, d.max_depth),
            max_objstm_objects: or_default(max_objstm_objects, d.max_objstm_objects),
            max_objects: or_default(max_objects, d.max_objects),
            max_decoded_stream: or_default(max_decoded_stream, d.max_decoded_stream),
            max_filter_chain: or_default(max_filter_chain, d.max_filter_chain),
        };
        prismpdf::Document::open_with_limits(data.to_vec(), limits)
            .map(|inner| Document { inner })
            .map_err(from_doc)
    }

    /// Number of pages.
    ///
    /// Naming rule 5: an argument-less getter is a property.
    #[wasm_bindgen(getter, js_name = pageCount)]
    pub fn page_count(&self) -> Fallible<usize> {
        self.inner.page_count().map_err(from_doc)
    }

    /// The header version as `{ major, minor }`, or `null` when the file declares none.
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> JsValue {
        self.inner.version().map_or(JsValue::NULL, |v| {
            js::obj([
                ("major", JsValue::from_f64(f64::from(v.major))),
                ("minor", JsValue::from_f64(f64::from(v.minor))),
            ])
        })
    }

    /// The **minimum** version the content actually requires, which can be below the declared
    /// header version.
    #[wasm_bindgen(getter, js_name = minVersion)]
    pub fn min_version(&self) -> Fallible<JsValue> {
        let (major, minor) = self.inner.min_pdf_version().map_err(from_doc)?;
        Ok(js::obj([
            ("major", JsValue::from_f64(f64::from(major))),
            ("minor", JsValue::from_f64(f64::from(minor))),
        ]))
    }

    /// How the document opened, and what recovery it needed.
    ///
    /// `mode` is `"recovered"` when the cross-reference data was *rebuilt* — not when the parser
    /// was merely lenient. A file can be visibly broken and still open `"strict"`.
    #[wasm_bindgen(getter, js_name = openReport)]
    pub fn open_report(&self) -> JsValue {
        let report = self.inner.open_report();
        let mode = match report.mode() {
            prismpdf::OpenMode::Strict => "strict",
            prismpdf::OpenMode::Recovered => "recovered",
        };
        let diagnostics = js::arr(report.diagnostics().iter().map(|d| {
            let reason = match d.reason {
                prismpdf::RecoveryReason::XrefParseFailure => "xrefParseFailure",
                prismpdf::RecoveryReason::UnreachableCatalog => "unreachableCatalog",
            };
            js::obj([
                ("reason", JsValue::from_str(reason)),
                ("offset", js::num(d.offset.map(|o| o as u32))),
            ])
        }));
        js::obj([
            ("mode", JsValue::from_str(mode)),
            ("diagnostics", diagnostics),
        ])
    }

    // --- Text -----------------------------------------------------------------------------

    /// One page's text in reading order.
    ///
    /// `prismpdf_page_text` takes a document first, so rule 2 makes this a method on `Document`
    /// with a page index — not a method on a `Page` that does not exist.
    ///
    /// An index past the end is an error (`NotFound`), because an out-of-range lookup is a caller
    /// mistake. That is the half of `NotFound` that is *not* absence.
    #[wasm_bindgen(js_name = pageText)]
    pub fn page_text(&self, index: usize) -> Fallible<String> {
        match prismpdf::page_text(&self.inner, index).map_err(from_facade)? {
            Some(text) => Ok(text),
            None => Err(error(Status::NotFound, format!("no page at index {index}"))),
        }
    }

    /// One page's text with layout preserved — line breaks and gaps taken from the text matrix,
    /// rather than the reading-order run `pageText` returns.
    #[wasm_bindgen(js_name = pageTextPositioned)]
    pub fn page_text_positioned(&self, index: usize) -> Fallible<String> {
        match prismpdf::page_text_positioned(&self.inner, index).map_err(from_facade)? {
            Some(text) => Ok(text),
            None => Err(error(Status::NotFound, format!("no page at index {index}"))),
        }
    }

    /// Every page's text, concatenated.
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> Fallible<String> {
        prismpdf::document_text(&self.inner).map_err(from_facade)
    }

    // --- Collections ----------------------------------------------------------------------

    /// The annotations on one page (§12.5). A page with no `/Annots` yields an empty array, not
    /// an error.
    #[wasm_bindgen(js_name = pageAnnotations)]
    pub fn page_annotations(&self, index: usize) -> Fallible<JsValue> {
        let items = prismpdf::page_annotations(&self.inner, index).map_err(from_facade)?;
        Ok(js::arr(items.iter().map(read::annotation)))
    }

    /// The images one page draws, recursing into form XObjects (§8.10).
    #[wasm_bindgen(js_name = pageImages)]
    pub fn page_images(&self, index: usize) -> Fallible<JsValue> {
        let items = prismpdf::page_images(&self.inner, index).map_err(from_facade)?;
        Ok(js::arr(items.iter().map(read::image)))
    }

    /// The terminal interactive form fields (§12.7). Empty when there is no AcroForm.
    #[wasm_bindgen(js_name = formFields)]
    pub fn form_fields(&self) -> Fallible<JsValue> {
        let items = self.inner.form_fields().map_err(from_doc)?;
        Ok(js::arr(items.iter().map(read::form_field)))
    }

    /// The outline tree's top level (§12.3.3); children nest inside each entry.
    pub fn outline(&self) -> Fallible<JsValue> {
        let items = self.inner.outline().map_err(from_doc)?;
        Ok(js::arr(items.iter().map(read::outline_item)))
    }

    /// Embedded files (§7.11), each decoded through its filter chain.
    pub fn attachments(&self) -> Fallible<JsValue> {
        let items = self.inner.attachments().map_err(from_doc)?;
        Ok(js::arr(items.iter().map(read::attachment)))
    }

    /// Every font the pages reference, with its embedded program where present.
    pub fn fonts(&self) -> Fallible<JsValue> {
        let items = prismpdf::document_fonts(&self.inner).map_err(from_facade)?;
        Ok(js::arr(items.iter().map(read::font)))
    }

    // --- Metadata -------------------------------------------------------------------------

    /// The XMP packet (§14.3.2) as raw XML, or `null`.
    #[wasm_bindgen(getter)]
    pub fn xmp(&self) -> Fallible<JsValue> {
        let value = self.inner.xmp_metadata().map_err(from_doc)?;
        Ok(js::text(value))
    }

    /// One `/Info` entry by key, decoded per §7.9.2.2 — so UTF-16BE and PDF 2.0 UTF-8 values come
    /// back as UTF-8. `null` when absent or not a string.
    pub fn info(&self, key: &str) -> Fallible<JsValue> {
        let Some(dict) = self.inner.info().map_err(from_doc)? else {
            return Ok(JsValue::NULL);
        };
        let name = prismpdf::cos::Name::from(key);
        // The value may be an indirect reference; resolve before reading it, the way
        // `prismpdf_document_info` does.
        let Some(raw) = dict.get(&name) else {
            return Ok(JsValue::NULL);
        };
        let resolved = self.inner.resolve(raw).map_err(from_doc)?;
        Ok(match resolved {
            prismpdf::cos::Object::String(s) => {
                JsValue::from_str(&prismpdf::decode_text_string(s.as_bytes()))
            }
            _ => JsValue::NULL,
        })
    }

    /// `/CreationDate` (§7.9.4), or `null`.
    #[wasm_bindgen(getter, js_name = creationDate)]
    pub fn creation_date(&self) -> Fallible<JsValue> {
        Ok(self
            .inner
            .creation_date()
            .map_err(from_doc)?
            .map_or(JsValue::NULL, read::date))
    }

    /// `/ModDate` (§7.9.4), or `null`.
    #[wasm_bindgen(getter, js_name = modificationDate)]
    pub fn modification_date(&self) -> Fallible<JsValue> {
        Ok(self
            .inner
            .modification_date()
            .map_err(from_doc)?
            .map_or(JsValue::NULL, read::date))
    }

    // --- Save -----------------------------------------------------------------------------

    /// Full rewrite with a classic cross-reference table (§7.5.4); normalises and repairs.
    ///
    /// The boundary is immutable: this serialises a **new** document and leaves the handle
    /// untouched. There is no mutating save in any Prism PDF binding.
    pub fn save(&self) -> Fallible<Vec<u8>> {
        self.inner.save().map_err(from_doc)
    }

    /// Full rewrite with a cross-reference *stream* (§7.5.8, PDF 1.5+).
    #[wasm_bindgen(js_name = saveCompact)]
    pub fn save_compact(&self) -> Fallible<Vec<u8>> {
        self.inner.save_compact().map_err(from_doc)
    }

    /// Full rewrite using object streams (§7.5.7) — the smallest of the three save modes.
    #[wasm_bindgen(js_name = savePacked)]
    pub fn save_packed(&self) -> Fallible<Vec<u8>> {
        self.inner.save_packed().map_err(from_doc)
    }
    // --- Manipulate -----------------------------------------------------------------------

    /// A new PDF containing only the pages at `indices`, in the order given — split, and page
    /// subsetting, which are the same operation.
    ///
    /// Rule 2: the facade's `extract_pages` takes the document as its receiver, so this is a
    /// method with an index list rather than a free function.
    ///
    /// `&[u32]` rather than the facade's `&[usize]`: `usize` is 32 bits on this target, so the
    /// two are the same width, and `u32` is the one that says `Uint32Array` unambiguously in the
    /// generated glue. The engine *skips* an out-of-range index rather than failing; the
    /// TypeScript layer rejects negative and fractional input, which would otherwise wrap into a
    /// huge index and be silently skipped — a footgun this conversion would be introducing, not
    /// one the engine has.
    #[wasm_bindgen(js_name = extractPages)]
    pub fn extract_pages(&self, indices: &[u32]) -> Fallible<Vec<u8>> {
        let indices: Vec<usize> = indices.iter().map(|&i| i as usize).collect();
        self.inner.extract_pages(&indices).map_err(from_doc)
    }

    /// `extractPages` with the preservation effects stated (§12.8, §14.7).
    ///
    /// Rule 7: a `*_with_report` variant is a `…WithReport` companion, never an optional
    /// parameter on the plain call. This is the first one bound.
    #[wasm_bindgen(js_name = extractPagesWithReport)]
    pub fn extract_pages_with_report(&self, indices: &[u32]) -> Fallible<JsValue> {
        let indices: Vec<usize> = indices.iter().map(|&i| i as usize).collect();
        self.inner
            .extract_pages_with_report(&indices)
            .map(|r| read::transform_report(&r))
            .map_err(from_doc)
    }

    /// A new PDF with one page's `/Rotate` set (§7.7.3.3); every other page is unchanged.
    ///
    /// `degrees` is `i32` where the facade takes `i64`, because wasm-bindgen maps `i64` to
    /// `BigInt` — `doc.rotatePage(0, 90n)` is a worse API than the range can possibly justify.
    /// The engine normalises to `0..360`, so no `i32` value is out of reach.
    #[wasm_bindgen(js_name = rotatePage)]
    pub fn rotate_page(&self, index: usize, degrees: i32) -> Fallible<Vec<u8>> {
        self.inner
            .rotate_page(index, i64::from(degrees))
            .map_err(from_doc)
    }

    /// `rotatePage` with the preservation effects stated.
    #[wasm_bindgen(js_name = rotatePageWithReport)]
    pub fn rotate_page_with_report(&self, index: usize, degrees: i32) -> Fallible<JsValue> {
        self.inner
            .rotate_page_with_report(index, i64::from(degrees))
            .map(|r| read::transform_report(&r))
            .map_err(from_doc)
    }
}

/// Accumulates the documents that `merge` combines.
///
/// The facade's `merge(docs: &[&Document])` cannot cross wasm-bindgen: a slice of *borrowed*
/// exported structs has no ABI representation, and the two shapes that do — taking `Vec<Document>`
/// by value, or reaching for the raw pointer behind a `JsValue` — either consume the caller's
/// handles or trade the whole crate's `deny(unwrap_used)` posture for pointer arithmetic.
///
/// This class buys the operation back by adding documents one at a time, where a single
/// `&Document` *is* expressible. It is deliberately **not** the public API: `src/document.ts`
/// wraps it in the module-level `merge()` the facade actually has, creating and freeing one
/// internally, so user code never sees a second handle to dispose. Deviation 6 in
/// `docs/naming.md`.
#[wasm_bindgen]
#[derive(Default)]
pub struct Merger {
    docs: Vec<prismpdf::Document>,
}

#[wasm_bindgen]
impl Merger {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Merger {
        Merger::default()
    }

    /// Append one document's pages.
    ///
    /// The engine's `Document` is `Clone`, and cloning is what makes the accumulator possible at
    /// all: `merge` needs every source alive simultaneously, and a `&Document` argument cannot
    /// outlive the call that passed it. The clone shares nothing with the caller's handle, so
    /// closing theirs before `finish()` is safe.
    ///
    /// The cost is honest and worth naming: a clone copies the source's bytes, so merging five
    /// 10 MB files holds ~50 MB more linear memory until the `Merger` is freed.
    pub fn add(&mut self, doc: &Document) {
        self.docs.push(doc.inner.clone());
    }

    /// Combine the added documents, in the order they were added (§7.7.3).
    pub fn finish(&self) -> Fallible<Vec<u8>> {
        let refs: Vec<&prismpdf::Document> = self.docs.iter().collect();
        prismpdf::merge(&refs).map_err(from_doc)
    }

    /// `finish` with the preservation effects stated. A merge builds a fresh object graph, so
    /// source signatures and structure trees cannot be carried over — the report says so.
    #[wasm_bindgen(js_name = finishWithReport)]
    pub fn finish_with_report(&self) -> Fallible<JsValue> {
        let refs: Vec<&prismpdf::Document> = self.docs.iter().collect();
        prismpdf::merge_with_report(&refs)
            .map(|r| read::transform_report(&r))
            .map_err(from_doc)
    }
}
