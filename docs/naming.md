# Naming: from the ABI to JavaScript

The engine's binding author's guide fixes a mechanical mapping from each C export to its idiomatic
name, so that knowledge transfers between bindings. This page applies those ten rules to
TypeScript and records every place this binding deviates.

## The rules, applied

**1. Strip the `prismpdf_` prefix.**

**2. The receiver is the first handle parameter, not the name prefix.**

```c
PrismPdfStatus prismpdf_page_text(const PrismPdfDocument *doc, uintptr_t index, char **out_text);
```

takes a document first, so it is `doc.pageText(index)` — the `page_` prefix names the *subject*,
not a receiver type. This is the rule that keeps a `Page` class from appearing.

**3. `<noun>_new*` → constructor; `document_open*` → static factories.**

| ABI | TypeScript |
|---|---|
| `prismpdf_document_open` | `Document.open(bytes)` |
| `prismpdf_document_open_with_password` | `Document.open(bytes, { password })` |
| `prismpdf_document_open_with_limits` | `Document.open(bytes, { limits })` |

**4. `<noun>_free` → the language's disposal idiom, never a public `free`.**

`Symbol.dispose` (so `using` works) plus an explicit `close()`. There is no finalizer: JavaScript's
`FinalizationRegistry` gives no ordering or timeliness guarantee, so offering one would suggest a
safety net that is not there. Deterministic disposal is the API. See [ownership.md](ownership.md).

**5. Argument-less getters become properties.**

`prismpdf_document_page_count` → `doc.pageCount`. A getter returning a boolean out-param returns a
plain `boolean`.

> **Note.** This rule puts real work behind `doc.text`, which JavaScript convention would normally
> keep a method. Cross-language consistency wins, and the doc comment says plainly that extraction
> runs on every read.

**6. Handle-less functions become statics on the top-level class.**

JavaScript modules have no top-level class to hang statics on, and inventing a `PrismPdf` namespace
object to hold one function would be ceremony. `prismpdf_version` is the module-level export
`engineVersion()`. The *placement* is what the rule protects — not a receiver, not on `Document` —
and a module-level export is JavaScript's spelling of that.

**7. `*_report` variants get a `…WithReport` companion, never an optional parameter.**

Reachable as of the manipulate area. `extractPagesWithReport()`, `rotatePageWithReport()` and
`mergeWithReport()` sit beside their plain forms — never `extractPages(indices, { report: true })`.
Each returns a `TransformReport`: the bytes, plus what the operation did to the source's
signatures (§12.8) and logical structure tree (§14.7). `saveWithReport()` will take the same shape
when it is bound.

**8. Permission helpers become an immutable value type with chainable methods.**

Not yet bound; the security area is not in this cut.

**9. `#[repr(C)]` enums keep their variant names; the C values are the contract.**

See deviation 2 below.

**10. String-pair inputs become the native map type.**

Not yet bound; `fill_form` is in the authoring area.

## Deviations

Six, each with the reason. A new one is added to this list before it is added to the code.

### 1. Collections are plain arrays, not list handles

**The rule.** The ABI models every collection as an owned list handle plus borrowed item pointers,
and the guide asks a binding to expose the list as a read-only sequence of item wrappers, each
holding its parent alive.

**Here.** `doc.fonts()` returns `Font[]` — plain objects in a plain array, with nothing to dispose
and no parent to keep alive.

**Why.** The list-handle model exists because C has neither a vector nor a lifetime: the borrowed
item is how the ABI avoids copying a `Vec<Item>` field-by-field, and the parent reference is how a
managed binding stops the collector freeing a list out from under an item. JavaScript has both, so
the model would be pure overhead — and worse, it would put a disposal order into user code (free
the list, and every item you kept goes stale) in exchange for nothing. The engine's own guide asks
for "the language's native read-only sequence"; in JavaScript that is an array.

The cost is real and worth naming: a page with a hundred large images copies all hundred payloads,
where a C binding would lend views. If that becomes a problem the answer is a lazy accessor on the
document, not a resurrection of list handles.

### 2. Enums cross as string unions, not numbers

**The rule.** Rule 9 — keep the variant names, and the C integer values are the contract.

**Here.** `FontFormat` is `"Type1" | "TrueType" | "Cff" | "OpenType"`; `ImageKind` and
`ImageColorSpace` likewise.

**Why.** JavaScript has no enum. A TypeScript `enum` emits a runtime object that cannot be erased,
which breaks `isolatedModules` consumers; a bare number would be unreadable in a debugger and
untypeable at a `switch`. Crossing the *names* keeps the half of the rule that matters — the
variant identity — and makes the numbering question moot, since there is no number to renumber.

`Status` is the exception and keeps its numbers, because there the number *is* the contract: it is
what `err.status === 5` means the same thing in every binding.

### 3. `Status` is a const object, not an enum

Same reason as above: `export const Status = {...} as const` erases cleanly and narrows just as
well. The values are copied from the engine's header and are never renumbered.

### 4. `engineVersion()` is a module export, not a static

Covered under rule 6. It is also named `engineVersion` rather than `version` to keep it distinct
from `doc.version`, which is the *document's* PDF version — two different things that would
otherwise both read as "version".

### 5. `PdfDate.utcOffsetMinutes` is nullable, with no `hasUtcOffset` flag

The ABI splits the offset into a `has_utc_offset` boolean beside an `int16_t` that carries no
meaning when the flag is false, because C has no `Option`. §7.9.4 permits a date that declares no
relationship to UTC, and JavaScript can say that directly: `null`. Reproducing the flag would be
carrying C's limitation into a language that does not have it.

### 6. `merge` reaches the boundary through a `Merger` the facade does not have

**The rule.** The raw layer is a flat, mechanical projection: one export per facade entry point,
no logic.

**Here.** The facade's `merge(docs: &[&Document])` has no wasm-bindgen representation — a slice of
*borrowed* exported structs is not an expressible argument type. The raw layer therefore exports a
`Merger` class (`new` / `add(&Document)` / `finish()`) that exists nowhere in the engine.

**Why.** Both alternatives are worse. Taking `Vec<Document>` *by value* is expressible, but it
consumes the caller's handles, so `merge([a, b])` would silently close `a` and `b` — a rule-4
violation wearing a signature. Recovering a `&Document` from a `JsValue` means reading the pointer
behind wasm-bindgen's generated glue, which trades this crate's `deny(clippy::unwrap_used)` posture
for hand-rolled pointer arithmetic on every call.

What makes it acceptable is that the deviation stops at the raw layer. The **public** API is
`merge(docs: Document[])` — a module-level function, matching the facade's free function exactly
under rule 6. `src/document.ts` constructs the `Merger`, fills it, and frees it in a `finally`, so
no caller sees the extra handle or has a second thing to dispose.

The cost is worth naming: `add` clones, because `merge` needs every source alive simultaneously and
a `&Document` argument cannot outlive the call that passed it. A clone copies the source's bytes,
so merging five 10 MB files holds roughly 50 MB more linear memory until the call returns.

## Where the guide and this binding agree exactly

Worth listing, because these are the ones a JavaScript author would be tempted to change:

- **No `Page` class.** Page-indexed calls take an index.
- **No mutating save.** Every transform returns new bytes.
- **`null` for absence, an error for an out-of-range index.** Both readings of `NotFound` are kept
  distinct.

  One wart is inherited rather than introduced: `rotatePage` past the last page raises `Parse`,
  not `NotFound`. The engine returns `DocError::BadPageTree`, and `prismpdf_document_rotate_page`
  maps every failure to `Parse` (`pdf-ffi/src/api/core.rs`, `Err(_) => PrismPdfStatus::Parse`), so
  that is what every binding reports. Matching it keeps one call meaning one thing in every
  language; improving on it here would not. `extractPages` sidesteps the question entirely — it
  *skips* an out-of-range index, because it describes a selection rather than naming a page.
- **One error type**, carrying the stable status. `Conformance` will subclass it when the
  conformance area lands, as it does in .NET — nothing else will.
