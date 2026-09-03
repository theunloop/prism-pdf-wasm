//! The one error shape, and the status codes it carries.
//!
//! Semantic contract 1 of the engine's `docs/BINDINGS.md`: *any status other than `Ok` (and other
//! than `NotFound` on an optional getter) raises a single error carrying the stable integer
//! status*. This binding goes through the Rust facade rather than the C ABI, so there is no
//! `PrismPdfStatus` to forward — the mapping below reproduces it, because the whole point of the
//! contract is that `err.status === 5` means the same thing in every Prism PDF binding.
//!
//! The values are copied from `crates/pdf-ffi/src/api/core.rs` and are append-only: they are
//! never renumbered upstream, so they are never renumbered here.

use wasm_bindgen::JsValue;

/// The stable status codes, mirroring `PrismPdfStatus` in the engine's C ABI.
///
/// Every code is declared, including the ones no call in this cut can currently raise. They are
/// the contract, not an inventory of what is reachable today: `src/errors.ts` exposes the full set
/// so a consumer's `switch` is written once, and the numbers must not shift when a later area —
/// authoring, composition — starts raising `Layout` or `NullArgument`.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Status {
    /// A required argument was null, or a value was rejected.
    NullArgument = 1,
    /// Unparseable, even after recovery.
    Parse = 2,
    /// The item does not exist. On an *optional* getter this is absence, not an error, and never
    /// reaches JavaScript — see `absent_is_null` in `document.rs`.
    NotFound = 3,
    /// An internal error. Unlike the native ABI this cannot include a caught panic: see
    /// `docs/wasm-constraints.md`.
    Internal = 4,
    /// Encrypted, and the supplied credentials are wrong or absent.
    Password = 5,
    /// A conformance pass refused the document — nothing is malformed, a standard's rule is unmet.
    Conformance = 6,
    /// A handle is stale, its owner was released, or it was already finalised.
    InvalidUse = 7,
    /// Composition rejected geometry or could not paginate.
    Layout = 8,
}

/// Build the structured value the TypeScript layer converts into a `PrismPdfError`.
///
/// A plain JS object, deliberately, rather than a `#[wasm_bindgen]` struct: a wasm-bindgen struct
/// crossing as an *error* would be an owned handle that JavaScript has to `free()`, so every
/// `catch` block in user code would become a leak unless it disposed the thing it caught. An
/// object literal is garbage-collected like any other.
///
/// The `__prismpdf` marker is how `src/errors.ts` tells one of these apart from an unrelated
/// throw (a wasm trap, an out-of-memory, a bug in the shim) that must not be dressed up as an
/// engine status.
pub fn error(status: Status, message: impl AsRef<str>) -> JsValue {
    let obj = js_sys::Object::new();
    let set = |k: &str, v: JsValue| {
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(k), &v);
    };
    set("__prismpdf", JsValue::TRUE);
    set("status", JsValue::from_f64(status as u32 as f64));
    set("message", JsValue::from_str(message.as_ref()));
    obj.into()
}

/// Map a document-layer error onto its status, the way the C ABI's call sites do.
///
/// `DocError` is `#[non_exhaustive]`, so this matches on the variants that carry a distinct status
/// and funnels the rest to `Parse` — which is exactly what `prismpdf_document_open` does with
/// everything that is not `NeedsPassword`.
pub fn doc_status(err: &prismpdf::DocError) -> Status {
    use prismpdf::DocError;
    match err {
        // §7.6: neither the user nor the owner password matched, or no certificate matched a
        // recipient. The one open failure that is not about the bytes being broken.
        DocError::NeedsPassword => Status::Password,
        // The engine refuses to encrypt under predictable material rather than pretending to
        // succeed. In a browser this means `crypto.getRandomValues` was unavailable — an
        // environment fault, not a malformed document.
        DocError::RandomUnavailable => Status::Internal,
        DocError::TargetVersionExceeded { .. } => Status::InvalidUse,
        _ => Status::Parse,
    }
}

/// Convert a document-layer error into the thrown value.
pub fn from_doc(err: prismpdf::DocError) -> JsValue {
    error(doc_status(&err), err.to_string())
}

/// Convert a facade error into the thrown value.
///
/// The facade aggregates three layers; the two standards layers are the conformance passes, which
/// the ABI gives their own status precisely so a caller can tell "your document breaks a rule"
/// apart from "your document is broken".
pub fn from_facade(err: prismpdf::Error) -> JsValue {
    match err {
        prismpdf::Error::Document(inner) => from_doc(inner),
        other @ (prismpdf::Error::PdfA(_) | prismpdf::Error::PdfUa(_)) => {
            error(Status::Conformance, other.to_string())
        }
        // `Error` is `#[non_exhaustive]`: a future engine release may add a layer. Reporting a
        // new variant as `Internal` is honest — this binding genuinely does not know what it is —
        // and keeps the message, which will name the real cause. The alternative, folding it into
        // `Parse`, would assert something false about a document that may be perfectly well formed.
        other => error(Status::Internal, other.to_string()),
    }
}
