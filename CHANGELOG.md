# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The **engine** version and this package's version move independently: `engineVersion()` reports the
former, `package.json` the latter. `ENGINE_TAG` records which engine release each version is built
against.

## [Unreleased]

### Added

The first cut: the vertical slice plus the read, parse and manipulate areas, built against engine
`v1.0.0-alpha.1`.

- **Open** — `Document.open(bytes)`, with `{ password }` for encrypted documents (§7.6) and
  `{ limits }` for the anti-DoS bounds, including the `maxDecodedStream` decompression-bomb guard.
- **Recovery reporting** — `doc.openReport`, distinguishing a rebuilt cross-reference from a
  strict open, with its bounded diagnostics.
- **Read** — `pageText`, `pageTextPositioned`, `text`, `version`, `minVersion`.
- **Inspect** — `pageAnnotations`, `pageImages`, `formFields`, `outline`, `attachments`, `fonts`.
- **Metadata** — `info(key)` decoded per §7.9.2.2, `xmp`, `creationDate`, `modificationDate`.
- **Save** — `save`, `saveCompact`, `savePacked`. The boundary is immutable: each returns new bytes.
- **Manipulate** — `extractPages(indices)`, which is split and page subsetting in one operation
  because they are one operation; `rotatePage(index, degrees)`; and the module-level `merge(docs)`.
  Inputs are never modified, here as everywhere.
- **Transform reports** — a `…WithReport` companion for each of the three, returning a
  `TransformReport`: the bytes, plus what the operation did to the source's signatures (§12.8) and
  logical structure tree (§14.7). Splitting and merging build a fresh object graph, so both are
  `removed` — which the report states rather than leaving a caller to discover by reopening the
  output. This is the first `*_report` surface bound, and it fixes the shape rule 7 prescribes.
- **Errors** — one `PrismPdfError` carrying the engine's stable integer `Status`.
- **Disposal** — `close()` and `Symbol.dispose`, with a wrapper-raised `InvalidUse` after close.
- **Two runtimes** — one API over a browser build and a Node build, reconciled by `init()`.

- **A demo that exercises the whole surface, one panel per capability.** Eight panels — overview,
  pages, text, find, structure, fonts, images, files — each opening with a readout of which call
  ran, over how much, and how long it took, measured with `performance.now()` around the call
  rather than asserted. The tab bar itself marks the one exception: a thin rule brackets **Pages**,
  the only panel that changes the document, so every tab either side of it is legible as read-only
  before you click into one. Three panels are new kinds of demonstration rather than new tables:
  **Find** extracts every page once and searches the result, in slices with a yield between them
  so a long document reports progress instead of freezing the tab; **Pages** is the editor and the
  viewer both, because splitting them was never two features — everything it can do is done to a
  page you can see, and a click on any thumbnail opens that same page full size, over the grid,
  with its own zoom and pager. Editing works over a list of slots rather than pages, so one page
  can appear twice the way `extractPages([0, 0])` means it to and each copy turns on its own, which
  takes two export paths because `/Rotate` belongs to the page: one extraction when every copy of a
  page shares an angle, and a document per page with a `merge` when they do not. No engine call
  happens until export, and the `TransformReport` printed afterwards names the path that ran and
  the parts that were removed; and **Fonts** puts `font.embedded.program` straight into a
  `FontFace`, so the browser draws a specimen from the engine's own bytes, and says plainly when a
  program is a format no browser will load. One document is open at a time — opening a file closes
  whatever was there, on the same `release` path an explicit close uses — so there is no file list
  to tick and no standalone merge feature; `merge` is still demonstrated, just internally, as the
  path Pages falls back to when one page is turned to two angles at once. There is also no
  permanent sidebar for that file list to sit in any more: the page is one column that shows either
  the empty state or the open document, full width, and what a sidebar used to carry alongside them
  — the handle count, the licence links — moved to a footer bar that costs one line instead of a
  column. Structure notes a `Sig`
  field when it finds one — the engine can see that a document was signed, but not whether the
  signature still holds, because that needs a wall clock and WebAssembly has none. The shell
  carries the small things too: a light/dark switch whose two segments are both visible and which
  follows the system until one of them is picked, drag-and-drop anywhere over the window, arrow-key
  paging, and a lightbox that magnifies an extracted image to its samples.
- **A sample document, written at build time.** `build/make-sample.mjs` assembles four pages with
  an outline that nests, a link that leaves the document and one that does not, two raw images in
  different colour spaces, a form field, an attached file, an XMP packet and a full `/Info`
  dictionary — so a first-time visitor has something to take apart in one click. It is written
  rather than copied: the shared corpus is deliberately minimal and must not be forked here, and a
  demo for a PDF *reader* may not lean on a PDF *writer*.
- **Page pictures in the demo are drawn by pdf.js, and labelled as such.** The engine has no
  rasterizer — page rendering is out of scope for its v1 — so the page thumbnails, and the
  full-size view a click on one opens, hand the bytes to
  [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0), vendored into the site under
  `vendor/pdfjs/` and loaded lazily when something first asks for a picture. It is disclaimed in
  the empty state and in a notice on the Pages panel, because a demo that let a visitor assume
  Prism drew those pages would be advertising a capability that does not exist. Nothing in the
  published package changes: pdf.js is a `devDependency` of this repository and is not in `files`.

### Conformance

Ported from the engine's journeys, against its shared corpus: the vertical slice, the parse
journey (every corpus file, collections, metadata, all three save modes), the manipulate journey
(ordering, repetition, the skipped out-of-range index, immutability of every input, and the three
reports), the failure paths, the browser entry point's loader, the two entry points' export
parity, and the slice inside headless Chromium. 73 assertions on Node, 9 in the browser, and 34
driving the assembled demo — including that the full-size page viewer paints real ink to a canvas,
that it says whose renderer drew it, that Prism and pdf.js agree on the page count, that a file
only Prism opens is reported as pdf.js's failure rather than the engine's, that the sample's
outline, link, form field and annotation all reach the Structure panel, that the engine's raw
image samples decode to the colours they were written with, and that a reordered, rotated, partial
export
reports what it dropped.

### Fixed

- **`import init, { Document } from "prism-pdf"` threw on Node.** The Node entry point
  exported `init` by name only, while the browser entry also exported it as the default — so
  the default-import form, which the README and `docs/getting-started.md` both lead with,
  failed under the `node` condition with `does not provide an export named 'default'`. Both
  entry points now export `init` both ways, and `tests/entry-parity.test.ts` compares the two
  export lists so they cannot drift apart again.
- **`npm run smoke` failed on every run.** Its tarball-contents check ran `tar tzf … | grep -q`
  under `set -o pipefail`; `grep -q` exits at the first match, so `tar` died of SIGPIPE and the
  pipeline reported 141 — meaning the check failed precisely when the file it looked for *was*
  present. The listing is now taken once into a file and grepped there. The smoke project also
  imports through the default-import form now, so the exports map is checked the way a consumer
  actually resolves it.

### Known gaps

- **The wrong-password failure path is not covered.** `docs/BINDINGS.md` requires it; the shared
  corpus ships no encrypted fixture and this cut cannot write one, since the security area is not
  bound. It is marked skipped with that reason rather than left silent, and closes when
  `saveEncrypted` lands. See `docs/conformance-suite.md`.
- **`open()` cannot combine `password` with `limits`.** The engine pairs them only through its
  `OpenOptions` handle, which is not bound yet. The combination is refused with `NullArgument`
  rather than silently dropping one — a caller must not believe their limits were applied to an
  encrypted upload when they were not.

### Blocked upstream

- **Signing and verification.** `SystemTime::now()` traps on `wasm32-unknown-unknown`, and the
  engine reads the clock on the signing, verification and revocation paths. The defensive
  `.unwrap_or(0)` at each site cannot help, because the trap is inside `now()`. Binding these would
  produce a call that takes the module down rather than returning an error. Unblocking is an engine
  change — inject the clock, as `SignSettings::set_signing_time` already does for signing time.
  See `docs/wasm-constraints.md`.

### Inherited quirks

- **`rotatePage` past the last page raises `Parse`, not `NotFound`.** Inherited rather than
  introduced: the engine returns `DocError::BadPageTree`, and `prismpdf_document_rotate_page`
  maps every failure to `Parse` (`Err(_) => PrismPdfStatus::Parse`), so every binding reports
  `Parse` for it. This one matches instead of quietly improving on it — a call must not mean
  different things in different languages — and the inconsistency is worth an engine issue.
  `extractPages` avoids the question: it *skips* an out-of-range index, because its argument
  describes a selection rather than naming a page. See `docs/naming.md`.

### Notes for anyone binding the next area

- A panic is a **trap** on this target, not a caught `Internal` status: `catch_unwind` cannot work
  where there is no unwinding. Treat every new export as one that must not panic.
- `getrandom`'s `js` feature is a direct dependency of the shim crate for feature unification, not
  because anything here calls it. Removing it breaks the build with a `compile_error!`.
